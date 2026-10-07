const flags = ['supportsEffort', 'supportsAdaptiveThinking', 'supportsFastMode', 'supportsAutoMode'];

/** Copy only advertised capability fields; explicit restrictions always win. */
export function claudeModelCapabilities(...rows) {
  const result = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const key of flags) {
      if (typeof row[key] === 'boolean') result[key] = result[key] === false ? false : row[key];
    }
    if (Array.isArray(row.supportedEffortLevels)) {
      const levels = [...new Set(row.supportedEffortLevels.filter(level => typeof level === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(level)))];
      result.supportedEffortLevels = result.supportedEffortLevels
        ? result.supportedEffortLevels.filter(level => levels.includes(level))
        : levels;
    }
  }
  return result;
}
