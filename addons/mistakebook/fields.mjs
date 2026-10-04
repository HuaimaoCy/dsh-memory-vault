// Pure metadata shared by the desktop editor and the local notebook store.
// 手写与普通笔记已合并（0.7.13）：note 类型内置手写画布；handwriting 仅作
// 旧记录的兼容别名保留（读入时按 note 处理，不再出现在新建入口）。
export const NOTE_TYPES = {
  mistake: { label: '错题', caption: '保留作答，定位错因，再练一次', icon: 'task' },
  physics: { label: '物理模型', caption: '从对象与假设，到方程与推导', icon: 'fact' },
  method: { label: '解题方法', caption: '理解每一步为什么成立', icon: 'decision' },
  vocabulary: { label: '英语词汇', caption: '积累词义、例句，检验记忆', icon: 'book' },
  note: { label: '笔记', caption: '文字、手写画布与图片，随想随记', icon: 'note' },
}
export const NEW_NOTE_TYPES = ['mistake', 'physics', 'method', 'vocabulary', 'note']
export const typeAlias = type => (type === 'handwriting' ? 'note' : type)
export const STRUCTURED_FIELDS = {
  physics: [['object', '研究对象与系统边界'], ['assumptions', '建模假设'], ['variables', '变量、单位与坐标约定'], ['equations', '控制方程与守恒关系'], ['derivation', '推导与求解过程'], ['conditions', '适用条件与边界'], ['pitfalls', '易错点与模型检验'], ['example', '应用例题']],
  method: [['prerequisites', '适用题型与前提'], ['steps', '解题步骤'], ['reasoning', '每一步的依据'], ['examples', '完整例题与过程'], ['pitfalls', '常见误区与替代方法']],
  vocabulary: [['word', '单词或短语'], ['phonetic', '音标'], ['partOfSpeech', '词性'], ['meaning', '中文释义'], ['synonyms', '近义词（逗号分隔）'], ['antonyms', '反义词（逗号分隔）'], ['examples', '例句与翻译'], ['collocations', '常用搭配'], ['forms', '词形变化'], ['usage', '用法与辨析']],
}
export function normalizeFields(type, raw = {}) {
  return Object.fromEntries((STRUCTURED_FIELDS[type] ?? []).map(([key]) => {
    const value = raw?.[key] ?? ''
    if (typeof value !== 'string' || value.length > (type === 'vocabulary' && key === 'word' ? 200 : 20000)) throw new Error('笔记字段不是有效文字或超过长度限制')
    return [key, value]
  }))
}
export const contentOf = record => ({ type: record.type ?? 'mistake', title: record.title ?? '', stem: record.stem, studentWork: record.studentWork,
  referenceAnswer: record.referenceAnswer, notes: record.notes, cause: record.cause, physics: record.physics, method: record.method, vocabulary: record.vocabulary })
