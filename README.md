# GitHub Star Analysis System

This system analyzes GitHub repository stars to detect potential artificial star inflation. It uses various patterns and heuristics to calculate a suspicion score and provide detailed insights about the repository's star patterns.

## How It Works

The system performs both basic and advanced analysis on repository stars, examining multiple suspicious patterns that might indicate artificial star inflation.

### Analysis Types

1. **Basic Analysis** (Always performed)

   - Analyzes star patterns visible without detailed user information
   - Checks usernames and basic repository metrics
   - Suitable for quick assessment

2. **Advanced Analysis** (When possible)
   - Performs detailed analysis of user accounts
   - Examines user behavior patterns
   - Provides comprehensive suspicious activity detection

### Suspicious Patterns Detected

#### 1. Username Patterns

- **Generic Usernames** (Score Impact: +15)

  - Matches patterns like: user123, dev456, test789
  - Indicates automatically generated accounts
  - Flags usernames with 4+ consecutive numbers

- **Bot-like Names** (Score Impact: +20)
  - More strict than generic username check
  - Additional patterns: temp123, a1234, githubuser1
  - Includes GitHub/star-related username patterns
  - Flags temporary or fake account indicators

#### 2. Account Engagement

- **Low Engagement** (Score Impact: +20)

  - Less than 2 followers AND less than 2 following
  - Indicates isolated accounts with no community interaction
  - Common in automated or fake accounts

- **No Repositories** (Part of profile check)
  - Accounts with zero public repositories
  - Suggests account created only for starring

#### 3. Timing Patterns

- **Same Day Pattern** (Score Impact: +40)

  - Account created, updated, and starred repository on same day
  - Strong indicator of automated account creation
  - Highly suspicious when found in bulk

- **Coordinated Starring** (Score Impact: +15 to +25)
  - Multiple accounts starring within same minute
  - 3+ stars per minute considered suspicious
  - > 5 coordinated: +15 to score
  - > 10 coordinated: +25 to score

#### 4. Account Creation Patterns

- **New Accounts** (Score Impact: +15)

  - Accounts less than 30 days old
  - Higher suspicion when many new accounts found

- **Creation Date Clustering** (Score Impact: +10 to +15)
  - Multiple accounts created on same day
  - > 5 accounts: +10 to score
  - > 10 accounts: +15 to score

#### 5. Repository Metrics

- **Star Velocity** (Score Impact: +10 to +35)

  - Abnormal star growth rate
  - > 50 stars/day: +10
  - > 100 stars/day: +20
  - > 500 stars/day: +30
  - > 1000 stars/day: +35

- **Fork Engagement** (Score Impact: +20)
  - Very low fork-to-star ratio (<0.5%)
  - Only checked for repos with >1000 stars
  - Indicates stars might not be from real users

#### 6. Profile Completeness

- **Missing Information** (Score Impact: +10)
  - No email set
  - No bio provided
  - Incomplete profiles common in fake accounts

### Suspicion Score Calculation

The system calculates a suspicion score (0-100) based on detected patterns:

- 0-39: Low suspicion
- 40-69: Medium suspicion
- 70-100: High suspicion

Each pattern contributes weighted points to the final score, with more suspicious patterns having higher weights.

### API Endpoints

1. `POST /analyze`

   - Main analysis endpoint
   - Parameters:
     - `repoUrl` or `owner` + `repo`
     - `deepAnalysis` (optional, default: true)
     - `maxStars` (optional, default: 5000)
     - `maxUsers` (optional, default: 200)

2. `GET /repo/:owner/:repo`

   - Basic repository information

3. `GET /results/:id`
   - Retrieve previous analysis results

### Rate Limiting and Error Handling

- Implements exponential backoff for API limits
- Handles GitHub API rate limits automatically
- Retries on server errors (502, 503)
- Caches results to prevent redundant analysis

## Response Format

```json
{
  "repository": {
    "fullName": "owner/repo",
    "stars": 1000,
    "forks": 50,
    // ... other repo info
  },
  "analysis": {
    "suspicionScore": 75,
    "suspiciousAccounts": {
      "genericUsernames": ["user123", ...],
      "botLikeNames": ["testbot1", ...]
    },
    "patterns": {
      // Detailed pattern counts
    },
    "suspicionIndicators": [
      "High same-day pattern: 60% of users",
      // ... other indicators
    ]
  },
  "metadata": {
    "analyzedAt": "2024-03-21T15:30:00Z",
    "analysisType": "advanced",
    "sampleSize": 1000,
    "detailedSample": 200
  }
}
```

## Usage Recommendations

1. Start with basic analysis for quick assessment
2. Use deep analysis for suspicious repositories
3. Monitor star velocity over time
4. Look for multiple suspicious patterns rather than single indicators
5. Consider context (repository age, type, community) when interpreting results

## Limitations

1. Cannot detect sophisticated bots with well-maintained profiles
2. Sample size limitations for large repositories
3. False positives possible for legitimate rapid growth
4. GitHub API rate limits restrict analysis speed
