export const log = (...args) => {
  const stack = new Error().stack.split('\n')[2];
  const match = stack.match(/\((.*):(\d+):(\d+)\)$/) || stack.match(/at (.*):(\d+):(\d+)$/);
  
  if (match) {
    const [_, filepath, line] = match;
    console.log(`[${new Date().toISOString()} | ${filepath}:${line}]`, ...args);
  } else {
    console.log(...args);
  }
};