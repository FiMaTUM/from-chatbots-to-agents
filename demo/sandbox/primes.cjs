const prime = n => n >= 2 && !Array.from({length: Math.max(0, Math.floor(Math.sqrt(n)) - 1)}, (_, i) => i + 2).some(d => n % d === 0);
const failed = [];
for (let n = 4; n < 1000; n += 2) {
  if (!Array.from({length: n - 1}, (_, i) => i + 2).some(p => prime(p) && prime(n - p))) failed.push(n);
}
console.log(JSON.stringify({checked:498, range:'even n, 4 <= n < 1000', counterexamples:failed, allPass:failed.length === 0}));
