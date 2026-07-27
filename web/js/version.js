// Deploy-time build id, shown in the footer. The repository always says
// 'dev'; deploy.sh overwrites this file with the deployed commit's short
// hash and date, then restores it — so the site tells you exactly what
// build a user is on, with no build step.
export const VERSION = 'dev';
