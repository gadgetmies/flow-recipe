const fs = require('fs');
const path = require('path');
const { validateRecipe } = require('./validateRecipe');

const recipePath = path.join(__dirname, 'recipes', 'negroni.xml');
const recipeXml = fs.readFileSync(recipePath, 'utf-8');

const result = validateRecipe(recipeXml);

console.log('Validation Result:');
console.log(`Valid: ${result.valid}`);
if (result.errors.length > 0) {
  console.log('\nErrors:');
  result.errors.forEach((error) => console.log(`  - ${error}`));
}
if (result.warnings.length > 0) {
  console.log('\nWarnings:');
  result.warnings.forEach((warning) => console.log(`  - ${warning}`));
}

