// Локальний плагін: заборона арифметичних операторів над `Money` (ADR-1).
//
// Branded type забороняє передати сирий number туди, де очікується Money,
// але `price / 3` чи `price * 0.15` компілюються й дають нецілі «копійки».
// Правило type-aware: дивиться на ТИП операнда, а не на назву змінної.
// Дозволено лише в packages/shared/src/money.ts — там операції йдуть через
// конструктор із перевіркою.

const ARITHMETIC = new Set(['+', '-', '*', '/', '%', '**']);
const ASSIGNMENT = new Set(['+=', '-=', '*=', '/=', '%=', '**=']);

/** Чи є тип (або будь-яка частина union / intersection) брендованим Money. */
function isMoney(type) {
  if (type.aliasSymbol?.name === 'Money') return true;
  if (type.isUnion?.() || type.isIntersection?.()) {
    if (type.types.some(isMoney)) return true;
  }
  return type.getProperties().some((p) => String(p.escapedName).includes('moneyBrand'));
}

/** @type {import('eslint').Rule.RuleModule} */
const noArithmetic = {
  meta: {
    type: 'problem',
    docs: { description: 'Арифметика над Money лише через функції packages/shared/money' },
    messages: {
      forbidden:
        'Оператор «{{operator}}» над Money: використай add / subtract / multiply / percentOf / allocate з @store/shared/money (ADR-1).',
    },
    schema: [],
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (services?.program === undefined || services.program === null) return {};
    const checker = services.program.getTypeChecker();
    const typeOf = (node) => checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));

    const check = (node, operator, operands) => {
      if (operands.some((operand) => isMoney(typeOf(operand)))) {
        context.report({ node, messageId: 'forbidden', data: { operator } });
      }
    };

    return {
      BinaryExpression(node) {
        if (ARITHMETIC.has(node.operator)) check(node, node.operator, [node.left, node.right]);
      },
      AssignmentExpression(node) {
        if (ASSIGNMENT.has(node.operator)) check(node, node.operator, [node.left, node.right]);
      },
      UpdateExpression(node) {
        check(node, node.operator, [node.argument]);
      },
      UnaryExpression(node) {
        if (node.operator === '-') check(node, 'унарний -', [node.argument]);
      },
    };
  },
};

export default { rules: { 'no-arithmetic': noArithmetic } };
