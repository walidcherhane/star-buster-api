const express = require("express");
const cors = require("cors");
const axios = require("axios");
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

// Utility function to add delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const response = await axios.get(
      `${GITHUB_API}/repos/${owner}/${repo}`,
      axiosConfig
    );
    return response.data;
  } catch (error) {
    if (error.response?.status === 404) {
      throw new Error("Repository not found");
    }
    throw new Error("Failed to fetch repository information");
  }
}

// Fetch stargazers with pagination
async function fetchStargazers(owner, repo, maxPages = 10) {
  const stargazers = [];
  let page = 1;

  while (page <= maxPages) {
    try {
      const response = await axios.get(
        `${GITHUB_API}/repos/${owner}/${repo}/stargazers`,
        {
          ...axiosConfig,
          params: {
            page: page,
            per_page: 100,
          },
        }
      );

      if (response.data.length === 0) break;

      stargazers.push(...response.data);
      page++;

      // Rate limiting delay
      await delay(100);
    } catch (error) {
      console.error(`Error fetching stargazers page ${page}:`, error.message);
      break;
    }
  }

  return stargazers;
}

// Fetch detailed user information for suspicious pattern detection
async function fetchUserDetails(users, maxUsers = 50) {
  const userDetails = [];
  const usersToCheck = users.slice(0, maxUsers); // Limit to avoid rate limits

  for (const user of usersToCheck) {
    try {
      const response = await axios.get(
        `${GITHUB_API}/users/${user.login}`,
        axiosConfig
      );
      userDetails.push(response.data);
      await delay(100); // Rate limiting
    } catch (error) {
      console.error(`Error fetching user ${user.login}:`, error.message);
    }
  }

  return userDetails;
}

// Check for generic username patterns
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

// Analyze star patterns
async function analyzeStarPatterns(stargazers, repoInfo) {
  const analysis = {
    totalStars: repoInfo.stargazers_count,
    analyzedSample: stargazers.length,
    patterns: {
      genericUsernames: 0,
      noAvatar: 0,
      newAccounts: 0,
      noRepos: 0,
      sameDayCreations: {},
    },
    suspicionIndicators: [],
    suspicionScore: 0,
  };

  // Basic pattern analysis on stargazers
  stargazers.forEach((user) => {
    if (isGenericUsername(user.login)) {
      analysis.patterns.genericUsernames++;
    }

    // Check for default avatar pattern (rough estimation)
    if (
      user.avatar_url &&
      user.avatar_url.includes("?v=4") &&
      !user.avatar_url.includes("avatars0") &&
      !user.avatar_url.includes("avatars1") &&
      !user.avatar_url.includes("avatars2") &&
      !user.avatar_url.includes("avatars3")
    ) {
      // This is a very rough check for default avatars
      analysis.patterns.noAvatar++;
    }
  });

  // Detailed analysis on a sample of users
  const sampleUsers = await fetchUserDetails(stargazers, 50);
  const currentDate = new Date();

  sampleUsers.forEach((user) => {
    console.log("🚀 ~ sampleUsers.forEach ~ user:", user);
    const createdAt = new Date(user.created_at);
    const accountAge = (currentDate - createdAt) / (1000 * 60 * 60 * 24);

    // Check for new accounts (less than 30 days)
    if (accountAge < 30) {
      analysis.patterns.newAccounts++;
    }

    // Check for accounts with no repositories
    if (user.public_repos === 0) {
      analysis.patterns.noRepos++;
    }

    // Track same-day account creations
    const creationDate = createdAt.toISOString().split("T")[0];
    analysis.patterns.sameDayCreations[creationDate] =
      (analysis.patterns.sameDayCreations[creationDate] || 0) + 1;
  });

  // Calculate suspicion score
  analysis.suspicionScore = calculateSuspicionScore(
    analysis,
    repoInfo,
    sampleUsers.length
  );

  // Generate suspicion indicators
  analysis.suspicionIndicators = generateSuspicionIndicators(
    analysis,
    repoInfo
  );

  return analysis;
}

// Calculate overall suspicion score
function calculateSuspicionScore(analysis, repoInfo, sampleSize) {
  let score = 0;

  // Repository age vs star velocity
  const repoAge =
    (new Date() - new Date(repoInfo.created_at)) / (1000 * 60 * 60 * 24);
  const starsPerDay = repoInfo.stargazers_count / Math.max(repoAge, 1);

  if (starsPerDay > 500) score += 40;
  else if (starsPerDay > 100) score += 30;
  else if (starsPerDay > 50) score += 20;
  else if (starsPerDay > 20) score += 10;

  // Generic username ratio
  const genericRatio =
    analysis.patterns.genericUsernames / analysis.analyzedSample;
  score += genericRatio * 30;

  // New accounts ratio (from sample)
  if (sampleSize > 0) {
    const newAccountRatio = analysis.patterns.newAccounts / sampleSize;
    score += newAccountRatio * 25;

    // No repos ratio
    const noReposRatio = analysis.patterns.noRepos / sampleSize;
    score += noReposRatio * 15;
  }

  // Fork to star ratio (low engagement indicator)
  const forkRatio =
    repoInfo.forks_count / Math.max(repoInfo.stargazers_count, 1);
  if (forkRatio < 0.01 && repoInfo.stargazers_count > 1000) {
    score += 20;
  }

  // Same-day creation clustering
  const maxSameDayCreations = Math.max(
    ...Object.values(analysis.patterns.sameDayCreations),
    0
  );
  if (maxSameDayCreations > 5) {
    score += 15;
  }

  return Math.min(Math.round(score), 100);
}

// Generate human-readable suspicion indicators
function generateSuspicionIndicators(analysis, repoInfo) {
  const indicators = [];

  const repoAge =
    (new Date() - new Date(repoInfo.created_at)) / (1000 * 60 * 60 * 24);
  const starsPerDay = repoInfo.stargazers_count / Math.max(repoAge, 1);

  if (starsPerDay > 100) {
    indicators.push(
      `Very high star velocity: ${starsPerDay.toFixed(1)} stars/day`
    );
  }

  const genericRatio =
    (analysis.patterns.genericUsernames / analysis.analyzedSample) * 100;
  if (genericRatio > 20) {
    indicators.push(
      `High percentage of generic usernames: ${genericRatio.toFixed(1)}%`
    );
  }

  const forkRatio = (repoInfo.forks_count / repoInfo.stargazers_count) * 100;
  if (forkRatio < 1 && repoInfo.stargazers_count > 1000) {
    indicators.push(`Very low fork-to-star ratio: ${forkRatio.toFixed(2)}%`);
  }

  const maxSameDayCreations = Math.max(
    ...Object.values(analysis.patterns.sameDayCreations),
    0
  );
  if (maxSameDayCreations > 5) {
    indicators.push(
      `Multiple accounts created on the same day: ${maxSameDayCreations}`
    );
  }

  return indicators;
}

// API Routes

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Main analysis endpoint
app.post("/analyze", async (req, res) => {
  try {
    const { repoUrl, owner, repo, maxPages = 10 } = req.body;

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

    // Fetch repository information
    const repoInfo = await fetchRepoInfo(repoOwner, repoName);

    console.log("🚀 ~ app.post ~ repoInfo:", repoInfo);
    // Fetch stargazers
    const stargazers = await fetchStargazers(repoOwner, repoName, maxPages);
    console.log("🚀 ~ app.post ~ stargazers:", stargazers);

    // Analyze patterns
    const analysis = await analyzeStarPatterns(stargazers, repoInfo);
    console.log("🚀 ~ app.post ~ analysis:", analysis);

    // Prepare response
    const response = {
      repository: {
        fullName: repoInfo.full_name,
        stars: repoInfo.stargazers_count,
        forks: repoInfo.forks_count,
        createdAt: repoInfo.created_at,
        language: repoInfo.language,
        description: repoInfo.description,
      },
      analysis: analysis,
      metadata: {
        analyzedAt: new Date().toISOString(),
        apiLimitsUsed: stargazers.length > 0,
        sampleSize: stargazers.length,
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

// Start server
app.listen(PORT, () => {
  console.log(`GitHub Star Checker API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
});
