export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';

/**
 * LinkedIn recruiting-post rotation. Peter Allen posts once per day (2 PM CT)
 * to grow his LinkedIn following and recruit realtors to Lifestyle Design
 * Realty. The generator rotates through these six topics in order (by day
 * index) so coverage stays balanced, then the AI writes an original post in
 * Peter's first-person voice for that topic.
 */
export const LINKEDIN_TOPICS: { key: string; label: string; angle: string }[] = [
  {
    key: "why_agents_leave",
    label: "Why agents leave brokerages",
    angle:
      "Why agents really leave their brokerage and what they are actually looking for (support, leadership, culture, splits, growth). Speak to the agent's frustration and what better looks like.",
  },
  {
    key: "leadership_culture",
    label: "Leadership and culture",
    angle:
      "Leadership and culture at Lifestyle Design Realty. What it feels like to be led well, invested in, and part of a team that has your back.",
  },
  {
    key: "income_potential",
    label: "Income potential",
    angle:
      "Income potential and what top agents do differently. Concrete habits, systems, and mindset that separate high earners from everyone else.",
  },
  {
    key: "mindset_motivation",
    label: "Mindset and motivation",
    angle:
      "Mindset and motivation for realtors. Encouragement for agents grinding through a hard market, staying consistent, and betting on themselves.",
  },
  {
    key: "wish_i_knew",
    label: "What I wish I knew earlier",
    angle:
      "What I wish I knew earlier in real estate. An honest lesson from Peter's own journey that a newer or stuck agent needs to hear.",
  },
  {
    key: "time_to_level_up",
    label: "Signs it's time to level up",
    angle:
      "Signs it is time to level up or switch teams. Help an agent recognize they have outgrown where they are and it is time for more.",
  },
];

/** Metricool brand (blogId) that has LinkedIn connected for these posts.
 * Back-compat only: the poster now auto-discovers ALL LinkedIn brands via
 * getLinkedinBrands() and posts to each, staggered. */
export const LINKEDIN_BRAND_BLOG_ID = 4807109;

/** First LinkedIn post goes out at 2 PM CT. */
export const LINKEDIN_POST_START_HOUR = 14;
/** Each additional LinkedIn brand is staggered this many minutes after the previous. */
export const LINKEDIN_BRAND_STAGGER_MINUTES = 30;
