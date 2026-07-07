import { getVideoById } from './server/db.js';

const v1 = await getVideoById(30025);
console.log('Video 30025 (SA):', JSON.stringify(v1, null, 2));

const v2 = await getVideoById(30079);
console.log('Video 30079 (Austin):', JSON.stringify(v2, null, 2));

process.exit(0);
