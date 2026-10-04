// These are bridge task fragments, not copies of a user's installed persona.
// Persistent research knowledge belongs in versioned project artifacts.
const guidance = Object.freeze({
  explore: '区分已建立结论、文献证据、合理猜测与未知。列出模型、假设、符号与近似阶数；有证据时提出替代解释。',
  numerics: '保存参数、随机种子、依赖版本与运行命令。核对量纲、已知极限、对称性、误差与收敛；有限样本不证明普遍理论主张。',
  writing: '按项目写作指南核对符号、术语、引用及期刊约定日期。区分已验证结果与待定主张，不把模型一致意见写成证明。',
});
export function researchGuidance(phase) { return guidance[phase] ?? '给出可核对的证据、适用范围、未决问题与下一步。'; }
