import { scrapeMatches } from './matches.js';
import { scrapeRoom } from './scraper.js';
try {
  console.log(JSON.stringify({ success: true, data: await (process.argv[2] === 'all' ? scrapeMatches() : scrapeRoom(process.argv[2])) }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ success: false, error: error.message }));
  process.exitCode = 1;
}
