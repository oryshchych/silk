// Conventional commits. Not for semantic versioning (the packages are not
// published) but so the history reads well when investigating an incident.

// AI attribution in commits is forbidden (AGENTS.md section 8b). Catch the
// trailers and notes that agents add by default instead of relying on memory.
const AI_ATTRIBUTION =
  /co-authored-by:.*\b(claude|anthropic|copilot|cursor|chatgpt|openai|codex|gemini)\b|generated (with|by) (claude|\[claude|copilot|cursor|chatgpt|ai\b)|noreply@anthropic\.com/i;

// All technical text is English (AGENTS.md section 0); Ukrainian is only for
// site content, which never appears in a commit message.
const CYRILLIC = /[Ѐ-ӿ]/;

export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'no-ai-attribution': ({ raw }) => [
          !AI_ATTRIBUTION.test(raw ?? ''),
          'AI attribution in a commit is forbidden (AGENTS.md section 8b): remove Co-Authored-By / "Generated with ..."',
        ],
        'no-cyrillic': ({ raw }) => [
          !CYRILLIC.test(raw ?? ''),
          'commit messages must be in English (AGENTS.md section 0): remove Cyrillic text',
        ],
      },
    },
  ],
  rules: {
    'body-max-line-length': [1, 'always', 100],
    'no-ai-attribution': [2, 'always'],
    'no-cyrillic': [2, 'always'],
  },
};
