require('dotenv').config();
const {PrismaClient} = require('@prisma/client');
const {PrismaPg} = require('@prisma/adapter-pg');
const adapter = new PrismaPg({connectionString: process.env.DATABASE_URL});
const p = new PrismaClient({adapter});
console.log('Direct llmProfile type:', typeof p.llmProfile);
console.log('Direct llmProfile:', p.llmProfile == null ? 'NULL/UNDEF' : 'OK object');

// Test proxy access
const obj = {};
const proxy = new Proxy({}, {
  get(_t, prop) {
    if (!obj.p) obj.p = p;
    const val = obj.p[prop];
    console.log('  proxy.get(' + String(prop) + ') ->', typeof val);
    return typeof val === 'function' ? val.bind(obj.p) : val;
  }
});
console.log('Proxy llmProfile type:', typeof proxy.llmProfile);
p.$disconnect();
