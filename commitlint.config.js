// Conventional commits — не для семантичного версіонування (пакети не
// публікуються), а щоб історія читалася при розборі інциденту.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-max-line-length': [1, 'always', 100],
  },
};
