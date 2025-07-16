const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const { default: puppeteer } = require("puppeteer");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// GitHub API configuration
const GITHUB_API = "https://api.github.com";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const axiosConfig = GITHUB_TOKEN
  ? {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
      },
    }
  : {
      headers: {
        Accept: "application/vnd.github.v3+json",
      },
    };

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Enhanced delay with exponential backoff
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Save analysis result function
async function saveAnalysisResult(
  repoOwner,
  repoName,
  repoUrl,
  analysis,
  repoInfo
) {
  const { data, error } = await supabase
    .from("analysis_results")
    .insert({
      repo_owner: repoOwner,
      repo_name: repoName,
      repo_url: repoUrl,
      suspicion_score: analysis.suspicionScore,
      total_stars: analysis.totalStars,
      analyzed_sample: analysis.analyzedSample,
      analysis_type: analysis.detailedSample > 0 ? "advanced" : "basic",
      suspicion_indicators: analysis.suspicionIndicators,
      repository_data: repoInfo,
      analysis_data: analysis,
    })
    .select("id")
    .single();

  if (error) throw error;
  return data.id;
}

// Rate limit handler with retry logic
async function handleRateLimit(error, retryCount = 0) {
  if (
    error.response?.status === 403 &&
    error.response?.headers["x-ratelimit-remaining"] === "0"
  ) {
    const resetTime =
      parseInt(error.response.headers["x-ratelimit-reset"]) * 1000;
    const waitTime = resetTime - Date.now() + 1000;

    console.log(
      `Rate limit hit. Waiting ${Math.round(waitTime / 1000)} seconds...`
    );
    await delay(waitTime);
    return true;
  }

  if (error.response?.status === 502 || error.response?.status === 503) {
    const waitTime = Math.min(1000 * Math.pow(2, retryCount), 30000);
    console.log(`Server error. Retrying in ${waitTime / 1000} seconds...`);
    await delay(waitTime);
    return retryCount < 3;
  }

  return false;
}

// Enhanced API call with retry logic
async function makeGitHubRequest(url, params = {}) {
  let retryCount = 0;

  while (retryCount < 5) {
    try {
      const response = await axios.get(url, {
        ...axiosConfig,
        params,
      });
      return response.data;
    } catch (error) {
      const shouldRetry = await handleRateLimit(error, retryCount);
      if (shouldRetry) {
        retryCount++;
        continue;
      }
      throw error;
    }
  }

  throw new Error("Max retries exceeded");
}

// Parse GitHub URL
function parseGitHubUrl(url) {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (match) {
    return {
      owner: match[1],
      repo: match[2].replace(".git", ""),
    };
  }
  return null;
}

// Fetch repository information
async function fetchRepoInfo(owner, repo) {
  try {
    return await makeGitHubRequest(`${GITHUB_API}/repos/${owner}/${repo}`);
  } catch (error) {
    if (error.response?.status === 404) {
      throw new Error("Repository not found");
    }
    throw new Error("Failed to fetch repository information");
  }
}

// Fetch stargazers with timestamps
async function fetchAllStargazersWithDates(owner, repo, maxStars = 10000) {
  const stargazers = [];
  let page = 1;

  console.log(`Fetching stargazers with timestamps for ${owner}/${repo}...`);

  while (stargazers.length < maxStars) {
    try {
      // Use the correct Accept header for starred_at timestamps
      const response = await axios.get(
        `${GITHUB_API}/repos/${owner}/${repo}/stargazers`,
        {
          headers: {
            ...axiosConfig.headers,
            Accept: "application/vnd.github.v3.star+json",
          },
          params: {
            page: page,
            per_page: 100,
          },
        }
      );

      if (response.data.length === 0) break;

      stargazers.push(...response.data);
      page++;

      if (stargazers.length % 500 === 0) {
        console.log(`Fetched ${stargazers.length} stargazers...`);
      }

      await delay(100);
    } catch (error) {
      console.error(`Error fetching stargazers page ${page}:`, error.message);
      break;
    }
  }

  return stargazers;
}

// Fetch detailed user information
async function fetchDetailedUserInfo(users, maxUsers = 200) {
  const userDetails = [];

  console.log(
    `Fetching detailed info for ${Math.min(users.length, maxUsers)} users...`
  );

  for (let i = 0; i < Math.min(users.length, maxUsers); i++) {
    try {
      const user = users[i];
      const userInfo = await makeGitHubRequest(
        `${GITHUB_API}/users/${user.user.login}`
      );

      userDetails.push({
        ...userInfo,
        starred_at: user.starred_at,
      });

      if ((i + 1) % 50 === 0) {
        console.log(
          `Processed ${i + 1}/${Math.min(users.length, maxUsers)} users...`
        );
      }

      await delay(150);
    } catch (error) {
      console.error(
        `Error fetching user ${users[i]?.user?.login}:`,
        error.message
      );
      continue;
    }
  }

  return userDetails;
}

// Advanced fake detection algorithm
function validateStar(user) {
  const createdAt = new Date(user.created_at);
  const updatedAt = new Date(user.updated_at);
  const starredAt = new Date(user.starred_at);

  const createdDate = createdAt.toDateString();
  const updatedDate = updatedAt.toDateString();
  const starredDate = starredAt.toDateString();

  const isFake =
    user.followers < 2 &&
    user.following < 2 &&
    user.public_gists === 0 &&
    user.public_repos < 5 &&
    createdAt > new Date("2022-01-01") &&
    !user.email &&
    !user.bio &&
    !user.blog &&
    createdDate === updatedDate &&
    updatedDate === starredDate &&
    user.hireable !== true &&
    user.hireable !== false;

  return isFake ? 1 : 0;
}

// Generic username detection
function isGenericUsername(username) {
  const patterns = [
    /^user\d+$/i,
    /^dev\w*\d+$/i,
    /^\w*bot\d*$/i,
    /^\w+\d{4,}$/,
    /^[a-z]+\d{6,}$/,
    /^(test|demo|sample)\w*\d*$/i,
  ];

  return patterns.some((pattern) => pattern.test(username));
}

// Bot-like name detection
function isBotLikeName(username) {
  const botPatterns = [
    /^user\d+$/i,
    /^dev\w*\d+$/i,
    /^\w*bot\d*$/i,
    /^\w+\d{4,}$/,
    /^[a-z]+\d{6,}$/,
    /^(test|demo|sample|fake|temp)\w*\d*$/i,
    /^[a-z]{1,3}\d{4,}$/,
    /^\w*github\w*\d*$/i,
    /^\w*star\w*\d*$/i,
  ];

  return botPatterns.some((pattern) => pattern.test(username));
}

// Advanced pattern analysis
function analyzeAdvancedPatterns(stargazers, detailedUsers, repoInfo) {
  const analysis = {
    totalStars: repoInfo.stargazers_count,
    analyzedSample: stargazers.length,
    detailedSample: detailedUsers.length,
    patterns: {
      genericUsernames: 0,
      newAccounts: 0,
      noRepos: 0,
      noEmail: 0,
      noBio: 0,
      noBlog: 0,
      lowEngagement: 0,
      sameDayPattern: 0,
      coordinated: 0,
      botLikeNames: 0,
      suspiciousCreationDates: {},
      starVelocitySpikes: [],
      realStars: 0,
      fakeStars: 0,
      suspiciousTimeWindows: [],
    },
    timeline: [],
    suspicionIndicators: [],
    suspicionScore: 0,
  };

  // Analyze basic patterns from all stargazers
  stargazers.forEach((stargazer) => {
    const username = stargazer.user.login.toLowerCase();

    if (isGenericUsername(username)) {
      analysis.patterns.genericUsernames++;
    }

    if (isBotLikeName(username)) {
      analysis.patterns.botLikeNames++;
    }
  });

  // Advanced analysis on detailed users
  const currentDate = new Date();
  const starsByMinute = {};

  detailedUsers.forEach((user) => {
    const createdAt = new Date(user.created_at);
    const updatedAt = new Date(user.updated_at);
    const starredAt = new Date(user.starred_at);
    const accountAge = (currentDate - createdAt) / (1000 * 60 * 60 * 24);

    // Basic patterns
    if (accountAge < 30) analysis.patterns.newAccounts++;
    if (user.public_repos === 0) analysis.patterns.noRepos++;
    if (!user.email) analysis.patterns.noEmail++;
    if (!user.bio) analysis.patterns.noBio++;
    if (!user.blog) analysis.patterns.noBlog++;
    if (user.followers < 2 && user.following < 2)
      analysis.patterns.lowEngagement++;

    // Same day pattern detection
    const createdDate = createdAt.toDateString();
    const updatedDate = updatedAt.toDateString();
    const starredDate = starredAt.toDateString();

    if (createdDate === updatedDate && updatedDate === starredDate) {
      analysis.patterns.sameDayPattern++;
    }

    // Coordinated starring detection
    const starMinute = starredAt.toISOString().slice(0, 16);
    starsByMinute[starMinute] = (starsByMinute[starMinute] || 0) + 1;

    // Track creation date clustering
    const creationDate = createdAt.toISOString().split("T")[0];
    analysis.patterns.suspiciousCreationDates[creationDate] =
      (analysis.patterns.suspiciousCreationDates[creationDate] || 0) + 1;

    // Apply fake detection algorithm
    const isFake = validateStar(user);
    if (isFake) {
      analysis.patterns.fakeStars++;
    } else {
      analysis.patterns.realStars++;
    }

    // Build timeline
    analysis.timeline.push({
      date: starredAt.toISOString().split("T")[0],
      user: user.login,
      isFake: isFake,
      accountAge: Math.round(accountAge),
      followers: user.followers,
      repos: user.public_repos,
    });
  });

  // Detect coordinated starring
  Object.entries(starsByMinute).forEach(([minute, count]) => {
    if (count > 3) {
      analysis.patterns.coordinated += count;
      analysis.patterns.suspiciousTimeWindows.push({
        time: minute,
        count: count,
      });
    }
  });

  // Calculate suspicion score
  analysis.suspicionScore = calculateAdvancedSuspicionScore(analysis, repoInfo);

  // Generate suspicion indicators
  analysis.suspicionIndicators = generateAdvancedSuspicionIndicators(
    analysis,
    repoInfo
  );

  return analysis;
}

// Enhanced suspicion score calculation
function calculateAdvancedSuspicionScore(analysis, repoInfo) {
  let score = 0;
  const { patterns } = analysis;

  // Repository velocity
  const repoAge =
    (new Date() - new Date(repoInfo.created_at)) / (1000 * 60 * 60 * 24);
  const starsPerDay = repoInfo.stargazers_count / Math.max(repoAge, 1);

  if (starsPerDay > 1000) score += 35;
  else if (starsPerDay > 500) score += 30;
  else if (starsPerDay > 100) score += 20;
  else if (starsPerDay > 50) score += 10;

  // Advanced patterns (only if we have detailed sample)
  if (analysis.detailedSample > 0) {
    const sameDayRatio = patterns.sameDayPattern / analysis.detailedSample;
    score += sameDayRatio * 40;

    const fakeRatio = patterns.fakeStars / analysis.detailedSample;
    score += fakeRatio * 35;

    const lowEngagementRatio = patterns.lowEngagement / analysis.detailedSample;
    score += lowEngagementRatio * 20;

    const newAccountRatio = patterns.newAccounts / analysis.detailedSample;
    score += newAccountRatio * 15;

    const noProfileRatio =
      (patterns.noEmail + patterns.noBio + patterns.noBlog) /
      (analysis.detailedSample * 3);
    score += noProfileRatio * 10;
  }

  // Basic patterns
  const genericRatio = patterns.genericUsernames / analysis.analyzedSample;
  score += genericRatio * 15;

  const botRatio = patterns.botLikeNames / analysis.analyzedSample;
  score += botRatio * 20;

  // Coordinated starring
  if (patterns.coordinated > 10) {
    score += 25;
  } else if (patterns.coordinated > 5) {
    score += 15;
  }

  // Fork engagement
  const forkRatio =
    repoInfo.forks_count / Math.max(repoInfo.stargazers_count, 1);
  if (forkRatio < 0.005 && repoInfo.stargazers_count > 1000) {
    score += 20;
  }

  // Creation date clustering
  const maxSameDayCreations = Math.max(
    ...Object.values(patterns.suspiciousCreationDates),
    0
  );
  if (maxSameDayCreations > 10) {
    score += 15;
  } else if (maxSameDayCreations > 5) {
    score += 10;
  }

  return Math.min(Math.round(score), 100);
}

// Enhanced suspicion indicators
function generateAdvancedSuspicionIndicators(analysis, repoInfo) {
  const indicators = [];
  const { patterns } = analysis;

  const repoAge =
    (new Date() - new Date(repoInfo.created_at)) / (1000 * 60 * 60 * 24);
  const starsPerDay = repoInfo.stargazers_count / Math.max(repoAge, 1);

  if (starsPerDay > 500) {
    indicators.push(
      `Extremely high star velocity: ${starsPerDay.toFixed(1)} stars/day`
    );
  } else if (starsPerDay > 100) {
    indicators.push(
      `Very high star velocity: ${starsPerDay.toFixed(1)} stars/day`
    );
  }

  if (analysis.detailedSample > 0) {
    const sameDayRatio =
      (patterns.sameDayPattern / analysis.detailedSample) * 100;
    if (sameDayRatio > 20) {
      indicators.push(
        `High same-day pattern: ${sameDayRatio.toFixed(
          1
        )}% of users created account, starred, and last updated on same day`
      );
    }

    const fakeRatio = (patterns.fakeStars / analysis.detailedSample) * 100;
    if (fakeRatio > 30) {
      indicators.push(
        `High fake star ratio: ${fakeRatio.toFixed(
          1
        )}% of analyzed users match fake profile criteria`
      );
    }

    const lowEngagementRatio =
      (patterns.lowEngagement / analysis.detailedSample) * 100;
    if (lowEngagementRatio > 50) {
      indicators.push(
        `Low engagement accounts: ${lowEngagementRatio.toFixed(
          1
        )}% have <2 followers and <2 following`
      );
    }

    const newAccountRatio =
      (patterns.newAccounts / analysis.detailedSample) * 100;
    if (newAccountRatio > 30) {
      indicators.push(
        `Many new accounts: ${newAccountRatio.toFixed(
          1
        )}% created within last 30 days`
      );
    }
  }

  if (patterns.coordinated > 5) {
    indicators.push(
      `Coordinated starring detected: ${patterns.coordinated} stars within same minute windows`
    );
  }

  const genericRatio =
    (patterns.genericUsernames / analysis.analyzedSample) * 100;
  if (genericRatio > 15) {
    indicators.push(`High generic username ratio: ${genericRatio.toFixed(1)}%`);
  }

  const botRatio = (patterns.botLikeNames / analysis.analyzedSample) * 100;
  if (botRatio > 10) {
    indicators.push(`Bot-like usernames detected: ${botRatio.toFixed(1)}%`);
  }

  const forkRatio = (repoInfo.forks_count / repoInfo.stargazers_count) * 100;
  if (forkRatio < 0.5 && repoInfo.stargazers_count > 1000) {
    indicators.push(
      `Very low fork engagement: ${forkRatio.toFixed(2)}% fork-to-star ratio`
    );
  }

  const maxSameDayCreations = Math.max(
    ...Object.values(patterns.suspiciousCreationDates),
    0
  );
  if (maxSameDayCreations > 5) {
    indicators.push(
      `Account creation clustering: ${maxSameDayCreations} accounts created on same day`
    );
  }

  return indicators;
}

// Basic analysis fallback
async function analyzeBasicPatterns(stargazers, repoInfo) {
  const analysis = {
    totalStars: repoInfo.stargazers_count,
    analyzedSample: stargazers.length,
    patterns: {
      genericUsernames: 0,
      botLikeNames: 0,
      suspiciousCreationDates: {},
    },
    suspicionIndicators: [],
    suspicionScore: 0,
  };

  // Basic pattern analysis
  stargazers.forEach((stargazer) => {
    const username = stargazer.user.login.toLowerCase();

    if (isGenericUsername(username)) {
      analysis.patterns.genericUsernames++;
    }

    if (isBotLikeName(username)) {
      analysis.patterns.botLikeNames++;
    }
  });

  // Basic suspicion score
  const repoAge =
    (new Date() - new Date(repoInfo.created_at)) / (1000 * 60 * 60 * 24);
  const starsPerDay = repoInfo.stargazers_count / Math.max(repoAge, 1);

  let score = 0;
  if (starsPerDay > 500) score += 30;
  else if (starsPerDay > 100) score += 20;
  else if (starsPerDay > 50) score += 10;

  const genericRatio =
    analysis.patterns.genericUsernames / analysis.analyzedSample;
  score += genericRatio * 20;

  const botRatio = analysis.patterns.botLikeNames / analysis.analyzedSample;
  score += botRatio * 25;

  analysis.suspicionScore = Math.min(Math.round(score), 100);

  // Basic indicators
  if (starsPerDay > 100) {
    analysis.suspicionIndicators.push(
      `High star velocity: ${starsPerDay.toFixed(1)} stars/day`
    );
  }

  if (genericRatio > 0.1) {
    analysis.suspicionIndicators.push(
      `Generic usernames: ${(genericRatio * 100).toFixed(1)}%`
    );
  }

  if (botRatio > 0.05) {
    analysis.suspicionIndicators.push(
      `Bot-like usernames: ${(botRatio * 100).toFixed(1)}%`
    );
  }

  return analysis;
}

// Routes
app.get("/", (req, res) => {
  res.json({
    name: "GitHub Star Analyzer API - Professional Edition",
    version: "2.0.0",
    status: "running",
    features: [
      "Advanced fake star detection",
      "Same-day pattern analysis",
      "Deep user profiling",
      "Coordinated starring detection",
      "Professional-grade algorithms",
    ],
    endpoints: {
      health: "GET /health",
      analyze: "POST /analyze",
      repo: "GET /repo/:owner/:repo",
    },
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    environment: process.env.NODE_ENV || "development",
    features: {
      advancedAnalysis: true,
      deepUserProfiling: true,
      rateLimitHandling: true,
    },
    rateLimit: {
      hasToken: !!GITHUB_TOKEN,
      estimated: GITHUB_TOKEN ? "5000/hour" : "60/hour",
    },
  });
});

// Main analysis endpoint
app.post("/analyze", async (req, res) => {
  const startTime = Date.now();

  try {
    const {
      repoUrl,
      owner,
      repo,
      deepAnalysis = true,
      maxStars = 5000,
      maxUsers = 200,
    } = req.body;

    let repoOwner, repoName;

    if (repoUrl) {
      const parsed = parseGitHubUrl(repoUrl);
      if (!parsed) {
        return res.status(400).json({ error: "Invalid GitHub URL" });
      }
      repoOwner = parsed.owner;
      repoName = parsed.repo;
    } else if (owner && repo) {
      repoOwner = owner;
      repoName = repo;
    } else {
      return res.status(400).json({
        error: "Please provide either repoUrl or both owner and repo",
      });
    }

    console.log(
      `Starting ${
        deepAnalysis ? "advanced" : "basic"
      } analysis for ${repoOwner}/${repoName}`
    );

    // Fetch repository information
    const repoInfo = await fetchRepoInfo(repoOwner, repoName);

    // Fetch stargazers with timestamps
    const stargazers = await fetchAllStargazersWithDates(
      repoOwner,
      repoName,
      maxStars
    );

    let analysis;

    if (deepAnalysis && stargazers.length > 0) {
      // Fetch detailed user information for advanced analysis
      const detailedUsers = await fetchDetailedUserInfo(stargazers, maxUsers);

      // Run advanced pattern analysis
      analysis = analyzeAdvancedPatterns(stargazers, detailedUsers, repoInfo);
    } else {
      // Fallback to basic analysis
      analysis = await analyzeBasicPatterns(stargazers, repoInfo);
    }

    const processingTime = Date.now() - startTime;

    // // Prepare response
    // const response = {
    //   repository: {
    //     fullName: repoInfo.full_name,
    //     stars: repoInfo.stargazers_count,
    //     forks: repoInfo.forks_count,
    //     createdAt: repoInfo.created_at,
    //     language: repoInfo.language,
    //     description: repoInfo.description,
    //     openIssues: repoInfo.open_issues_count || 0,
    //     watchers: repoInfo.watchers_count || 0,
    //   },
    //   analysis: analysis,
    //   metadata: {
    //     analyzedAt: new Date().toISOString(),
    //     analysisType: deepAnalysis ? "advanced" : "basic",
    //     sampleSize: stargazers.length,
    //     detailedSample: analysis.detailedSample || 0,
    //     processingTime: processingTime,
    //   },
    // };

    console.log(
      `Analysis complete. Suspicion score: ${analysis.suspicionScore} (${processingTime}ms)`
    );

    // Save result to database
    const resultId = await saveAnalysisResult(
      repoOwner,
      repoName,
      `https://github.com/${repoOwner}/${repoName}`,
      analysis,
      repoInfo
    );

    const response = {
      id: resultId,
      repository: {
        fullName: repoInfo.full_name,
        stars: repoInfo.stargazers_count,
        forks: repoInfo.forks_count,
        createdAt: repoInfo.created_at,
        language: repoInfo.language,
        description: repoInfo.description,
        openIssues: repoInfo.open_issues_count || 0,
        watchers: repoInfo.watchers_count || 0,
      },
      analysis: analysis,
      shareUrl: `${process.env.FRONTEND_URL}/results/${resultId}`,
      metadata: {
        analyzedAt: new Date().toISOString(),
        analysisType: deepAnalysis ? "advanced" : "basic",
        sampleSize: stargazers.length,
        detailedSample: analysis.detailedSample || 0,
        processingTime: processingTime,
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Analysis error:", error);
    res.status(500).json({
      error: error.message || "Internal server error",
    });
  }
});

// Get repository basic info only
app.get("/repo/:owner/:repo", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const repoInfo = await fetchRepoInfo(owner, repo);

    res.json({
      fullName: repoInfo.full_name,
      stars: repoInfo.stargazers_count,
      forks: repoInfo.forks_count,
      createdAt: repoInfo.created_at,
      language: repoInfo.language,
      description: repoInfo.description,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get analysis result by ID
app.get("/results/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("analysis_results")
      .select("*")
      .eq("id", id)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (error || !data) {
      return res
        .status(404)
        .json({ error: "Analysis result not found or expired" });
    }

    res.json({
      id: data.id,
      repository: data.repository_data,
      analysis: data.analysis_data,
      createdAt: data.created_at,
      shareUrl: `${process.env.FRONTEND_URL}/results/${data.id}`,
    });
  } catch (error) {
    console.error("Error fetching result:", error);
    res.status(500).json({ error: "Failed to fetch result" });
  }
});

// OG Image generation endpoint
app.get("/og/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("analysis_results")
      .select("*")
      .eq("id", id)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (error || !data) {
      return res.status(404).send("Analysis result not found");
    }

    const analysis = data.analysis_data;
    const repository = data.repository_data;

    // Generate OG image
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 630 });

    const getSuspicionLevel = (score) => {
      if (score >= 70) return { level: "High Risk", color: "#dc2626" };
      if (score >= 40) return { level: "Medium Risk", color: "#d97706" };
      return { level: "Low Risk", color: "#059669" };
    };

    const suspicion = getSuspicionLevel(analysis.suspicionScore);

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body {
              margin: 0;
              padding: 40px;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              display: flex;
              flex-direction: column;
              justify-content: center;
              height: 550px;
            }
            .container {
              background: rgba(255, 255, 255, 0.1);
              backdrop-filter: blur(10px);
              border-radius: 20px;
              padding: 40px;
              border: 1px solid rgba(255, 255, 255, 0.2);
            }
            .header {
              display: flex;
              align-items: center;
              margin-bottom: 30px;
            }
            .logo {
              font-size: 32px;
              font-weight: bold;
              margin-right: 20px;
            }
            .repo-name {
              font-size: 36px;
              font-weight: bold;
              margin-bottom: 20px;
            }
            .score-container {
              display: flex;
              align-items: center;
              justify-content: space-between;
              margin-bottom: 30px;
            }
            .score {
              font-size: 72px;
              font-weight: bold;
              color: ${suspicion.color};
            }
            .score-label {
              font-size: 24px;
              color: ${suspicion.color};
              font-weight: 600;
            }
            .stats {
              display: flex;
              gap: 40px;
              font-size: 18px;
            }
            .stat {
              display: flex;
              align-items: center;
              gap: 8px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <div class="logo">⭐ StarBuster</div>
            </div>
            <div class="repo-name">${repository.full_name}</div>
            <div class="score-container">
              <div>
                <div class="score">${analysis.suspicionScore}/100</div>
                <div class="score-label">${suspicion.level}</div>
              </div>
            </div>
            <div class="stats">
              <div class="stat">
                <span>⭐</span>
                <span>${repository.stargazers_count.toLocaleString()} stars</span>
              </div>
              <div class="stat">
                <span>🔍</span>
                <span>${analysis.analyzedSample} analyzed</span>
              </div>
              <div class="stat">
                <span>📊</span>
                <span>${
                  analysis.detailedSample > 0 ? "Advanced" : "Basic"
                } Analysis</span>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;

    await page.setContent(html);
    const screenshot = await page.screenshot({ type: "png" });

    await browser.close();

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(screenshot);
  } catch (error) {
    console.error("Error generating OG image:", error);
    res.status(500).send("Error generating image");
  }
});

// Error handlers
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    message:
      process.env.NODE_ENV === "production"
        ? "Something went wrong"
        : err.message,
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: "Not found",
    message: `Route ${req.originalUrl} not found`,
  });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`GitHub Star Analyzer API v2.0 running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(
    `GitHub Token: ${
      GITHUB_TOKEN ? "Configured" : "Not configured (limited rate)"
    }`
  );
  console.log(
    "Features: Advanced analysis, Deep profiling, Coordinated detection"
  );
});
