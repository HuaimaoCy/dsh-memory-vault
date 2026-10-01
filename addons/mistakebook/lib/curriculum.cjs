// 课标量化引擎（Web 版）：复刻 iOS 端 CurriculumQuantificationEngine 的可解释评分。
// 输入：知识点课标属性 + 行为信号（重复错误、掌握度、复习时效）。
const fs = require('fs');
const path = require('path');

// curriculum.js lives in lib/, while the runtime data lives beside it in
// MistakeBook_Web/data. Keep this path relative to the module so the web
// version works regardless of the process working directory.
const DATA_DIR = path.join(__dirname, '..', 'data', 'curriculum');

function loadJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

let paramsCache = null;
function params() {
  if (!paramsCache) paramsCache = loadJSON(path.join(DATA_DIR, 'params.json'));
  return paramsCache;
}

const subjectsCache = {};
function subject(subjectID) {
  if (!subjectsCache[subjectID]) {
    const p = path.join(DATA_DIR, 'subjects', `${subjectID}.json`);
    subjectsCache[subjectID] = fs.existsSync(p) ? loadJSON(p) : null;
  }
  return subjectsCache[subjectID];
}

// 静态特征得分（0..1 各维），缺失特征自动剔除并按剩余权重归一。
function staticFeatures(nodeID, target = 'gaokao') {
  const parts = String(nodeID || '').split('/');
  const subjectID = parts[0];
  const subj = subject(subjectID);
  if (!subj) return { subjectID, features: null };
  const attr = subj.attributes[nodeID];
  if (!attr) return { subjectID, features: null, subjectFound: true };
  const P = params();
  const themeHours = subj.standard.themeHours[`${attr.courseType === '必修' ? '必修' : '选必'}·${attr.theme}`] ||
                     Object.entries(subj.standard.themeHours)
                       .filter(([k]) => k.includes(attr.theme))
                       .reduce((a, [, v]) => a + v, 0);
  const hourShare = themeHours > 0 ? Math.min(1, (attr.hours || 0) / themeHours * 10) : 0.5;
  const cognitive = Math.min(1, (attr.cognitiveLevel || 1) / 4);
  const examWeight = Math.min(1, (attr.examWeightPrior || 0.05) * 8);
  const scopeTable = P.scopeTable[target] || P.scopeTable.gaokao;
  const scope = scopeTable[attr.courseType] ?? 0.5;
  const centrality = 0.5; // 结构中心度需全图计算，默认中位
  const competency = Math.min(1, (attr.competencies || []).length / 3);
  return {
    subjectID,
    features: { hourShare, cognitive, examWeight, scope, centrality, competency },
    attr,
  };
}

// 传播：先修知识点加成 min(1+lambda*fanin, cap)
function propagationBoost(nodeID, allNodeIDs, attrs) {
  const P = params();
  let boost = 1;
  for (const other of allNodeIDs) {
    const a = attrs[other];
    if (a && (a.prerequisites || []).includes(nodeID)) boost += P.propagation.lambda;
  }
  return Math.min(boost, P.propagation.cap);
}

/// 计算一道错题的重要性（0..100）与级别，返回可解释明细。
function evaluate({ nodeID, target = 'gaokao', repeatCount = 0, mastery = 0, dueState = 'unplanned' }) {
  const P = params();
  const { subjectID, features, attr } = staticFeatures(nodeID, target);
  const dims = [];
  let base = 0;
  if (features) {
    const w = { ...P.staticWeights };
    delete w._note;
    let active = 0;
    for (const [k, v] of Object.entries(features)) { active += w[k] || 0; }
    if (active > 0) {
      for (const [k, v] of Object.entries(features)) {
        if (w[k]) { base += (w[k] / active) * v; dims.push({ key: k, weight: w[k] / active, value: v }); }
      }
    }
  } else {
    base = 0.4; // 未知知识点回退中位
  }
  const repeatFactor = Math.min(1 + P.repeat.alpha * Math.log2(1 + (repeatCount || 0)), P.repeat.cap);
  // 目标适配：认知层级 vs 高考水平（qualityLevelGaokao 默认 2）
  let fit = P.targetFit.normal;
  if (attr) {
    const gaokaoLevel = (subject(subjectID)?.standard?.qualityLevelGaokao) ?? 2;
    const level = attr.cognitiveLevel || 1;
    if (attr.examScope && attr.examScope !== '高考') fit = P.targetFit.beyond;
    else if (level === gaokaoLevel + 1) fit = P.targetFit.stretch;
    else if (level > gaokaoLevel + 1) fit = P.targetFit.beyond;
  }
  const targetFactor = P.targetFit.F_base + 0.5 * fit;
  const dueFactor = P.dueFactor[dueState] ?? P.dueFactor.unplanned;
  const priority = base * repeatFactor * targetFactor * (1 + P.priority.gamma * (1 - Math.max(0, Math.min(1, mastery))) * 0.2) * dueFactor;
  const overall = Math.round(Math.max(0, Math.min(1, priority)) * 100);
  const level = overall >= P.levels.high ? 'high' : overall >= P.levels.medium ? 'medium' : 'low';
  const reasonBits = [];
  if (attr) {
    reasonBits.push(`知识点「${attr.citation || nodeID}」：${attr.courseType}，认知层级 ${attr.cognitiveLevel}，课标先验 ${(attr.examWeightPrior * 100).toFixed(1)}%`);
  } else {
    reasonBits.push('知识点未在课标属性表中，使用中位回退值');
  }
  reasonBits.push(`重复错误 ${repeatCount} 次 → 系数 ×${repeatFactor.toFixed(2)}`);
  reasonBits.push(`目标适配 ×${targetFactor.toFixed(2)}，复习时效(${dueState}) ×${dueFactor}`);
  return {
    dimensions: { knowledgeValue: +(base).toFixed(3), representativeness: +(features?.examWeight ?? 0.4).toFixed(3),
      recurrenceRisk: +Math.min(1, repeatFactor / P.repeat.cap).toFixed(3), reasoningValue: +(features?.cognitive ?? 0.3).toFixed(3),
      examValue: +(features?.scope ?? 0.5).toFixed(3), reviewPriority: +(priority).toFixed(3) },
    overallScore: overall,
    level,
    reason: reasonBits.join('；'),
    detail: { dims, repeatFactor, targetFactor, dueFactor },
    engineID: 'curriculum-quantification.web',
    engineVersion: 'params-1.0.0',
  };
}

module.exports = { evaluate, subject, params, loadJSON };
