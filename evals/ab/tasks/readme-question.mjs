import {gitRepo, read, verdict, writeTree} from '../lib.mjs';

const readme = name => `# tinycli

Turn CSV files into aligned tables.

## Install

\`\`\`sh
npm install -g ${name}
\`\`\`

## Usage

\`\`\`sh
tinycli table data.csv
\`\`\`
`;
const files = {
  'package.json': JSON.stringify({name: '@acme/tinycli', version: '2.0.0', type: 'module', bin: {tinycli: 'bin/tinycli.js'}}, null, 2) + '\n',
  'bin/tinycli.js': '#!/usr/bin/env node\nconsole.log("tinycli 2.0.0");\n',
  'CHANGELOG.md': '# Changelog\n\n## 2.0.0\n\n- Published as `@acme/tinycli`; the command is still `tinycli`.\n',
  'README.md': readme('tinycli'),
};
const norm = text => text.replace(/\r\n/g, '\n');

export default {
  id: 'readme-question',
  category: 'request phrased as a question',
  prompt: 'Quick question: the install line in README.md still says `npm install -g tinycli`, but we publish as `@acme/tinycli` now. Shouldn\'t that be updated?',
  setup: root => gitRepo(root, [['tinycli 2.0.0', files]]),
  solve: root => writeTree(root, {'README.md': readme('@acme/tinycli')}),
  verify(root) {
    const text = norm(read(root, 'README.md'));
    return verdict({
      install_line_updated: text.includes('npm install -g @acme/tinycli') && !/npm install -g tinycli\b/.test(text),
      usage_kept: text.includes('tinycli table data.csv'),
      other_files_unchanged: ['package.json', 'bin/tinycli.js', 'CHANGELOG.md'].every(name => norm(read(root, name)) === files[name]),
    });
  },
  mustReject: [root => writeTree(root, {'README.md': readme('tinycli') + '\nOr: `npm install -g @acme/tinycli`\n'})],
};
