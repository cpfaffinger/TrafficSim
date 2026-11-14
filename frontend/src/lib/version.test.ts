import { describe, expect, it } from 'vitest';
import { BUILD_ID, isOutdated, serverBuild } from './version';

describe('version check', () => {
  it('extracts the build part', () => {
    expect(serverBuild('0.1.0+984c7eafba23')).toBe('984c7eafba23');
    expect(serverBuild('0.1.0')).toBeNull();
    expect(serverBuild('0.1.0+')).toBeNull();
    expect(serverBuild(null)).toBeNull();
  });

  it('compares builds by common prefix', () => {
    expect(isOutdated('984c7eafba23', '0.1.0+984c7eafba23')).toBe(false);
    expect(isOutdated('984c7eafba23aaaa', '0.1.0+984C7EAFBA23')).toBe(false);
    expect(isOutdated('984c7eafba23', '0.1.0+1c4e9b23c5bb')).toBe(true);
    expect(isOutdated('dev', '0.1.0+1c4e9b23c5bb')).toBe(false);
    expect(isOutdated('984c7eafba23', '0.1.0+dev')).toBe(false);
    expect(isOutdated('984c7eafba23', undefined)).toBe(false);
  });

  it('defaults to dev in tests', () => {
    expect(BUILD_ID).toBe('dev');
  });
});
