import {existsSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {gitRepo, read, run, unchanged, verdict, writeTree} from '../lib.mjs';

// build.js prints ~15k log lines and reports one config problem at a time, buried mid-log.
const BUILD = `import {mkdirSync, readFileSync, existsSync, writeFileSync} from 'node:fs';
const config = JSON.parse(readFileSync('build.config.json', 'utf8'));
const errors = [];
const log = line => process.stdout.write('[build] ' + line + '\\n');
for (let pass = 0; pass < 3; pass++) for (let i = 0; i < 2500; i++) log('pass ' + pass + ' scanning chunk ' + i + ' of 2500 ... ok (cache hit)');
if (typeof config.output?.banner !== 'string') errors.push("config key 'output.banner' is required and must be a string");
for (const name of config.modules ?? []) if (!existsSync('src/' + name + '.js')) errors.push("module '" + name + "' listed in config.modules has no file src/" + name + ".js");
const missing = (await import('node:fs')).readdirSync('src').map(file => file.replace(/\\.js$/, '')).filter(name => !(config.modules ?? []).includes(name));
if (missing.length) errors.push('every file in src/ must be listed in config.modules; missing: ' + missing.join(', '));
if (errors.length) log('error: ' + errors[0]);
for (let pass = 3; pass < 6; pass++) for (let i = 0; i < 2500; i++) log('pass ' + pass + ' linking chunk ' + i + ' of 2500 ... ok');
if (errors.length) { process.stderr.write('Build failed: ' + errors.length + ' error(s), see the log above.\\n'); process.exit(1); }
mkdirSync(config.output.dir ?? 'dist', {recursive: true});
const body = config.modules.map(name => '// --- ' + name + '\\n' + readFileSync('src/' + name + '.js', 'utf8')).join('\\n');
writeFileSync((config.output.dir ?? 'dist') + '/bundle.js', '/*! ' + config.output.banner + ' */\\n' + body);
log('wrote ' + (config.output.dir ?? 'dist') + '/bundle.js');
`;

const SRC = {
  'src/format.js': 'export const pad = (text, width) => String(text).padStart(width);\n',
  'src/maths.js': 'export const square = value => value * value;\n',
  'src/strings.js': 'export const shout = text => text.toUpperCase() + "!";\n',
};

export default {
  id: 'noisy-build',
  category: 'buried error in very long output',
  prompt: 'Make `node build.js` succeed (exit code 0) so that it writes dist/bundle.js containing every module in src/. Fix the configuration in build.config.json; do not modify build.js or anything in src/. Use a banner of "tinybundle".',
  setup: root => gitRepo(root, [['Bundle setup', {'package.json': '{"type":"module"}\n', 'build.js': BUILD, ...SRC,
    'build.config.json': JSON.stringify({modules: ['format', 'math', 'strings'], output: {dir: 'dist'}}, null, 2) + '\n'}]]),
  solve: root => writeTree(root, {'build.config.json': JSON.stringify({modules: ['format', 'maths', 'strings'], output: {dir: 'dist', banner: 'tinybundle'}}, null, 2) + '\n'}),
  verify(root, before) {
    const build = run(process.execPath, ['build.js'], {cwd: root, timeout: 120000});
    const bundle = path.join(root, 'dist', 'bundle.js');
    const text = existsSync(bundle) ? read(root, 'dist/bundle.js') : '';
    return verdict({
      build_js_and_src_unchanged: unchanged(before, root, 'build.js') && unchanged(before, root, 'src/'),
      build_succeeds: build.status === 0,
      bundle_has_every_module: Object.values(SRC).every(source => text.includes(source.trim())) && readdirSync(path.join(root, 'src')).length === 3,
      banner: text.startsWith('/*! tinybundle */'),
    }, {stderr: build.stderr.slice(-300)});
  },
};
