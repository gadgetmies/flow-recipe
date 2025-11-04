const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');

let operationsCache = null;

function loadOperations() {
  if (operationsCache) return operationsCache;
  
  const operationsPath = path.join(__dirname, 'recipes', 'operations.xml');
  const operationsXml = fs.readFileSync(operationsPath, 'utf-8');
  const parser = new DOMParser();
  const operationsDoc = parser.parseFromString(operationsXml, 'text/xml');
  
  const operations = {};
  const operationElements = operationsDoc.getElementsByTagName('operation');
  
  for (let i = 0; i < operationElements.length; i++) {
    const op = operationElements[i];
    const name = op.getAttribute('name');
    
    const options = {};
    const optionElements = op.getElementsByTagName('option');
    for (let j = 0; j < optionElements.length; j++) {
      const opt = optionElements[j];
      const optName = opt.getAttribute('name');
      options[optName] = {
        required: opt.getAttribute('required') === 'true',
        type: opt.getAttribute('type') || 'numeric',
        defaultUnit: opt.getAttribute('default-unit'),
      };
    }
    
    const timelineEl = op.getElementsByTagName('timeline')[0];
    const timeline = timelineEl ? {
      active: parseInt(timelineEl.getAttribute('active'), 10),
      passive: parseInt(timelineEl.getAttribute('passive') || '0', 10),
    } : null;
    
    operations[name] = {
      name,
      title: op.getElementsByTagName('title')[0]?.textContent || name,
      minInputs: parseInt(op.getAttribute('min-inputs') || '0', 10),
      maxInputs: op.getAttribute('max-inputs') ? parseInt(op.getAttribute('max-inputs'), 10) : null,
      minOutputs: parseInt(op.getAttribute('min-outputs') || '1', 10),
      maxOutputs: op.getAttribute('max-outputs') ? parseInt(op.getAttribute('max-outputs'), 10) : null,
      requiresTools: op.getAttribute('requires-tools') === 'true',
      options,
      timeline,
    };
  }
  
  operationsCache = operations;
  return operations;
}

function validateRecipe(recipeXml) {
  const parser = new DOMParser();
  const recipeDoc = parser.parseFromString(recipeXml, 'text/xml');
  
  if (recipeDoc.documentElement.nodeName === 'parsererror') {
    return {
      valid: false,
      errors: [`XML parsing error: ${recipeDoc.documentElement.textContent}`],
    };
  }
  
  const operations = loadOperations();
  const errors = [];
  const warnings = [];
  
  const tasks = recipeDoc.getElementsByTagName('task');
  
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const operationName = task.getAttribute('operation');
    
    if (!operationName) {
      errors.push(`Task ${i + 1}: Missing operation attribute`);
      continue;
    }
    
    const operation = operations[operationName];
    
    if (!operation) {
      warnings.push(`Task ${i + 1}: Unknown operation "${operationName}"`);
      continue;
    }
    
    const inputsContainer = task.getElementsByTagName('inputs')[0];
    const inputCount = inputsContainer 
      ? inputsContainer.getElementsByTagName('input').length
      : task.getElementsByTagName('input').length;
    
    if (inputCount < operation.minInputs) {
      errors.push(
        `Task ${i + 1} (${operationName}): Requires at least ${operation.minInputs} input(s), found ${inputCount}`
      );
    }
    
    if (operation.maxInputs !== null && inputCount > operation.maxInputs) {
      errors.push(
        `Task ${i + 1} (${operationName}): Requires at most ${operation.maxInputs} input(s), found ${inputCount}`
      );
    }
    
    const outputsContainer = task.getElementsByTagName('outputs')[0];
    const outputCount = outputsContainer
      ? outputsContainer.getElementsByTagName('output').length
      : task.getElementsByTagName('output').length;
    
    if (outputCount < operation.minOutputs) {
      errors.push(
        `Task ${i + 1} (${operationName}): Requires at least ${operation.minOutputs} output(s), found ${outputCount}`
      );
    }
    
    if (operation.maxOutputs !== null && outputCount > operation.maxOutputs) {
      errors.push(
        `Task ${i + 1} (${operationName}): Requires at most ${operation.maxOutputs} output(s), found ${outputCount}`
      );
    }
    
    if (operation.requiresTools) {
      const tools = task.getElementsByTagName('tool');
      if (tools.length === 0) {
        warnings.push(
          `Task ${i + 1} (${operationName}): Operation typically requires tools, but none specified`
        );
      }
    }
    
    const options = task.getElementsByTagName('option');
    const providedOptions = {};
    for (let j = 0; j < options.length; j++) {
      const opt = options[j];
      providedOptions[opt.getAttribute('name')] = opt;
    }
    
    for (const [optName, optDef] of Object.entries(operation.options)) {
      if (optDef.required && !providedOptions[optName]) {
        errors.push(
          `Task ${i + 1} (${operationName}): Required option "${optName}" is missing`
        );
      }
      
      if (providedOptions[optName]) {
        const optEl = providedOptions[optName];
        const numericValue = optEl.getElementsByTagName('numeric-value')[0];
        const textContent = optEl.getElementsByTagName('text-content')[0];
        
        if (optDef.type === 'numeric' && !numericValue) {
          errors.push(
            `Task ${i + 1} (${operationName}): Option "${optName}" must be numeric, but no numeric-value found`
          );
        }
        
        if (optDef.type === 'text' && !textContent && !optEl.textContent.trim()) {
          errors.push(
            `Task ${i + 1} (${operationName}): Option "${optName}" must be text, but no text content found`
          );
        }
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

module.exports = {
  validateRecipe,
  loadOperations,
};
