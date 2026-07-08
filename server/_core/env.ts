export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  metricoolApiToken: process.env.METRICOOL_API_TOKEN ?? "",
  metricoolBlogId: parseInt(process.env.METRICOOL_BLOG_ID ?? "0", 10),
  metricoolUserId: parseInt(process.env.METRICOOL_USER_ID ?? "0", 10),
  // Google Drive OAuth2 (permanent refresh token — auto-refreshes forever)
  googleDriveRefreshToken: process.env.GOOGLE_DRIVE_REFRESH_TOKEN ?? "",
  googleDriveClientId: process.env.GOOGLE_DRIVE_CLIENT_ID ?? "",
  googleDriveClientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? "",
};
