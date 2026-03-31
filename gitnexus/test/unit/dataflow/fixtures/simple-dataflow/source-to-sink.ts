// Simple taint flow: user input flows to SQL query
// This is a test fixture for dataflow analysis

function processUserInput(input: string): void {
  const sanitized = sanitize(input);
  executeQuery(sanitized);
}

function sanitize(value: string): string {
  return value.replace(/['";]/g, '');
}

function executeQuery(query: string): void {
  // SQL execution - SINK
}
