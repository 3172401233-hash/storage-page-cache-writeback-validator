#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeScenario } from './analyze.js';
import { formatReport } from './report.js';

function printUsage() {
  console.log(`用法:
  node src/cli.js <scenario.json> [--json] [--strict]

选项:
  --json    输出完整 JSON 报告
  --strict  存在 error 级违规时以退出码 1 结束
  -h, --help 显示帮助

所有存储均为本地进程内模型，场景从本地 JSON 文件读取。`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const asJson = args.includes('--json');
  const strict = args.includes('--strict');
  const file = args.find((arg) => !arg.startsWith('-'));
  if (!file) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  let input;
  try {
    input = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'));
  } catch (error) {
    console.error(`读取/解析场景文件失败: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  let report;
  try {
    report = analyzeScenario(input);
  } catch (error) {
    console.error(`场景输入无效: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  if (asJson) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));

  if (strict && report.summary.errors > 0) process.exitCode = 1;
}

main();
