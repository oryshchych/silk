// Conventional commits — не для семантичного версіонування (пакети не
// публікуються), а щоб історія читалася при розборі інциденту.

// Атрибуція ШІ в комітах заборонена (AGENTS.md §8b). Ловимо трейлери й
// примітки, які агенти додають за замовчуванням, а не покладаємося на пам'ять.
const AI_ATTRIBUTION =
  /co-authored-by:.*\b(claude|anthropic|copilot|cursor|chatgpt|openai|codex|gemini)\b|generated (with|by) (claude|\[claude|copilot|cursor|chatgpt|ai\b)|noreply@anthropic\.com/i;

export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'no-ai-attribution': ({ raw }) => [
          !AI_ATTRIBUTION.test(raw ?? ''),
          'атрибуція ШІ в коміті заборонена (AGENTS.md §8b): прибери Co-Authored-By / «Generated with …»',
        ],
      },
    },
  ],
  rules: {
    'body-max-line-length': [1, 'always', 100],
    'no-ai-attribution': [2, 'always'],
  },
};
