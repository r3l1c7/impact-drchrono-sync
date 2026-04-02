import 'dotenv/config';
import { fetchTests } from './impact-client.js';

const tests = await fetchTests();

// Sort by date descending to find the most recent
const sorted = [...tests].sort((a, b) => {
  const dateA = new Date(a.currentDate || 0);
  const dateB = new Date(b.currentDate || 0);
  return dateB - dateA;
});

console.log(`\nTotal tests: ${tests.length}`);
console.log(`\n── 10 Most Recent Tests ──\n`);

sorted.slice(0, 10).forEach((t, i) => {
  console.log(`${i + 1}. ${t.userFirstName} ${t.userLastName}`);
  console.log(`   testID: ${t.testID} | Date: ${t.currentDate} | DOB: ${t.userDateOfBirth}`);
  console.log(`   Type: ${t.testType || 'N/A'} | RecordType: ${t.recordTypeIdentifier || 'N/A'}`);
  console.log('');
});

console.log(`── Last 3 in array (original API order) ──\n`);
tests.slice(-3).forEach((t, i) => {
  console.log(`[${tests.length - 3 + i}] ${t.userFirstName} ${t.userLastName} | Date: ${t.currentDate} | testID: ${t.testID}`);
});

process.exit(0);
