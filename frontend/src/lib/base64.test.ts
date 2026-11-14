import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from './base64';

describe('bytesToBase64', () => {
  it('encodes small and chunked inputs', () => {
    expect(bytesToBase64(new Uint8Array([76, 67, 86, 49]))).toBe('TENWMQ==');
    const big = new Uint8Array(0x8000 * 2 + 3).fill(65);
    expect(atob(bytesToBase64(big)).length).toBe(big.length);
  });
});
