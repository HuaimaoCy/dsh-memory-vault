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
  const hoursByTheme = subj.standard?.themeHours || {};
  const themeHours = hoursByTheme[`${attr.courseType === '必修' ? '必修' : '选必'}·${attr.theme}`] ||
                     Object.entries(hoursByTheme)
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

// 高考考频：按知识点的考频先验 examWeightPrior 分档（高频/中高频/中频/低频/极低频）。
function frequencyOf(attr) {
  const P = params();
  const config = P.examFrequency || {};
  if (!attr) return { value: config.neutral ?? 0.5, label: '未匹配知识点', prior: null }
  const prior = Number(attr.examWeightPrior ?? 0)
  const tiers = Array.isArray(config.tiers) ? config.tiers : []
  const tier = tiers.find(item => prior >= item.min) ?? tiers[tiers.length - 1]
  return { value: tier ? tier.value : 0.5, label: tier ? tier.label : '中频', prior }
}

/// 计算一篇笔记的复习重要性（0..100）与级别，返回可解释明细。
// 行为为主 + 高考考频显式计权：行为（到期 44% / 薄弱 28% / 重复出错 16% /
// 久未复习 12%，合计 1）按 (1-考频权重) 缩放，考频再按知识点分档计入
// （高考目标 0.18、合格考 0.06、未匹配知识点权重为 0 取中性）；课标静态
// 特征仍作 ±15% 微调。考频从课标微调里移出单列，避免同一信号计两次。
function evaluate({ nodeID, target = 'gaokao', repeatCount = 0, mastery = 0, dueState = 'unplanned',
                    daysOverdue = 0, daysUntil = 0, lastReviewAt = null, reviewState = '' } = {}) {
  const P = params();
  const now = Date.now();
  const clamp = (v) => Math.max(0, Math.min(1, v));

  // 1) 到期压力：逾期最紧（随逾期天数继续升高），从未排期次之，已排远期最低。
  let dueScore; let dueText;
  if (dueState === 'overdueShort' || dueState === 'overdueLong') {
    dueScore = 0.78 + 0.22 * Math.min(1, (daysOverdue || 0) / 14);
    dueText = `已逾期 ${Math.max(1, Math.round(daysOverdue || 1))} 天`;
  } else if (dueState === 'unplanned') {
    dueScore = 0.55; dueText = '尚未排期复习';
  } else {
    const days = Math.max(0, daysUntil || 0);
    dueScore = Math.max(0.12, 0.34 - 0.2 * Math.min(1, days / 21));
    dueText = `约 ${Math.round(days)} 天后到期`;
  }

  // 2) 掌握薄弱度与 3) 重复出错强度。
  const weakness = clamp(1 - (Number.isFinite(+mastery) ? +mastery : 0));
  const repeat = Math.min(1, (repeatCount || 0) / 6);

  // 4) 久未复习：相对上次复习（或最后更新）的天数；已掌握的封顶一半。
  const anchor = Date.parse(lastReviewAt || '');
  const staleDays = Number.isFinite(anchor) && anchor > 0 ? Math.max(0, (now - anchor) / 86400000) : 0;
  const staleness = Math.min(1, staleDays / 30) * (reviewState === 'mastered' ? 0.5 : 1);

  const behavior = 0.44 * dueScore + 0.28 * weakness + 0.16 * repeat + 0.12 * staleness;

  // 5) 高考考频：知识点考频先验分档计权；高考目标权重高于合格考；未匹配不参与。
  const freqConfig = P.examFrequency || {};
  const { features, attr } = staticFeatures(nodeID, target);
  const frequency = frequencyOf(attr);
  const frequencyWeight = attr ? (target === 'huige' ? (freqConfig.weightHuige ?? 0.06) : (freqConfig.weightGaokao ?? 0.18)) : 0;
  const weighted = (1 - frequencyWeight) * behavior + frequencyWeight * frequency.value;

  // 6) 课标微调：匹配到知识点时 0.85..1.15，未匹配为 1。
  let base = null;
  if (features) {
    const w = { ...P.staticWeights };
    delete w._note;
    let active = 0;
    for (const [k, v] of Object.entries(features)) active += w[k] || 0;
    if (active > 0) {
      base = 0;
      for (const [k, v] of Object.entries(features)) if (w[k]) base += (w[k] / active) * v;
    }
  }
  const curriculumFactor = base === null ? 1 : 0.85 + 0.3 * base;

  const priority = clamp(weighted * curriculumFactor);
  const overall = Math.round(priority * 100);
  const level = overall >= P.levels.high ? 'high' : overall >= P.levels.medium ? 'medium' : 'low';

  const reasonBits = [];
  reasonBits.push(`到期压力 ${dueScore.toFixed(2)}（${dueText}）`);
  reasonBits.push(`掌握度 ${(1 - weakness).toFixed(2)}，薄弱 ${weakness.toFixed(2)}`);
  reasonBits.push(`重复出错 ${repeatCount || 0} 次（强度 ${repeat.toFixed(2)}）`);
  reasonBits.push(`距上次复习约 ${Math.round(staleDays)} 天`);
  reasonBits.push(attr ? `高考考频 ${frequency.label}（先验 ${frequency.prior}，权重 ${frequencyWeight.toFixed(2)}）` : '未匹配知识点，考频中性')
  reasonBits.push(attr ? `课标微调 ×${curriculumFactor.toFixed(2)}（${attr.citation || nodeID}）` : '未匹配课标知识点，权重中性');
  return {
    dimensions: { knowledgeValue: +(base ?? 0.5).toFixed(3), representativeness: +(features?.examWeight ?? 0.4).toFixed(3),
      recurrenceRisk: +repeat.toFixed(3), reasoningValue: +(features?.cognitive ?? 0.3).toFixed(3),
      examValue: +(features?.scope ?? 0.5).toFixed(3), examFrequency: +frequency.value.toFixed(3), reviewPriority: +priority.toFixed(3) },
    overallScore: overall,
    level,
    reason: reasonBits.join('；'),
    detail: { dueScore, weakness, repeat, staleness, behavior, frequency: frequency.value, frequencyLabel: frequency.label, frequencyPrior: frequency.prior, frequencyWeight, weighted, curriculumFactor },
    engineID: 'curriculum-quantification.web',
    engineVersion: 'behavior-3.0',
  };
}

module.exports = { evaluate, subject, params, loadJSON };
