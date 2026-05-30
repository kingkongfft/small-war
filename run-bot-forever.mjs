#!/usr/bin/env node

import { spawn } from 'node:child_process';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const CHARACTER = process.argv[3] ?? 'tank';
const RESTART_DELAY_MS = 2000;

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  while (true) {
    const child = spawn(process.execPath, ['demo-bot.js', CHARACTER, BASE], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LLM_MODEL: process.env.LLM_MODEL ?? 'GPT5',
      },
      stdio: 'inherit',
    });

    const exitCode = await new Promise(resolve => {
      child.on('exit', code => resolve(code ?? 0));
      child.on('error', () => resolve(1));
    });

    console.log(`[runner] bot exited with code ${exitCode}; restarting in ${RESTART_DELAY_MS} ms`);
    await sleep(RESTART_DELAY_MS);
  }
}

main().catch(err => {
  console.error('[runner] fatal error', err);
  process.exit(1);
});
