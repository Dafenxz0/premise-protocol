const major = Number(process.versions.node.split(".")[0]);

if (major !== 24) {
  throw new Error(`PremiseBench-Agent requires Node 24.x; found ${process.version}`);
}

console.log(`Node 24 gate: PASS (${process.version})`);
