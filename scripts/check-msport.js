import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const msData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'msport.json'), 'utf8'));

console.log("=== TOP LEVEL KEYS ===");
console.log(Object.keys(msData));

console.log("\n=== DATA KEYS ===");
console.log(Object.keys(msData.data || {}));

const tournaments = msData.data?.tournaments || [];
console.log("\n=== TOURNAMENTS FOUND ===", tournaments.length);

tournaments.forEach((t, i) => {
  console.log(`  ${i + 1}. ${t.tournament} (${t.events?.length || 0} events)`);
});