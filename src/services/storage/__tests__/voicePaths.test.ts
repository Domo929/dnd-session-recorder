import { describe, expect, it } from 'vitest';

import {
  VOICE_CONTAINER,
  buildClusterSnippetPath,
  buildVoiceSamplePath,
  isClusterSnippetPath,
  voiceSamplePathOwnedBy,
} from '../voicePaths';

describe('voice clip blob paths', () => {
  it('namespaces enrollment clips under the user id', () => {
    expect(buildVoiceSamplePath('user_1', 'abc')).toBe(`${VOICE_CONTAINER}/user_1/abc.opus`);
  });

  it('detects voice-clip ownership by prefix and resists prefix confusion', () => {
    const p = buildVoiceSamplePath('user_1', 'abc');
    expect(voiceSamplePathOwnedBy(p, 'user_1')).toBe(true);
    expect(voiceSamplePathOwnedBy(p, 'user_2')).toBe(false);
    expect(voiceSamplePathOwnedBy(`${VOICE_CONTAINER}/user_12/x.opus`, 'user_1')).toBe(false);
  });

  it('builds session-namespaced cluster snippet paths', () => {
    const p = buildClusterSnippetPath('sess_9', 2);
    expect(p).toBe(`${VOICE_CONTAINER}/clusters/sess_9/2.opus`);
    expect(isClusterSnippetPath(p)).toBe(true);
  });

  it('distinguishes cluster snippets from user clips', () => {
    expect(isClusterSnippetPath(buildVoiceSamplePath('user_1', 'abc'))).toBe(false);
    // a cluster snippet is not owned by a normal user
    expect(voiceSamplePathOwnedBy(buildClusterSnippetPath('s', 0), 'user_1')).toBe(false);
  });

  it('rejects path-traversal and key-splitting segments', () => {
    expect(() => buildVoiceSamplePath('user_1', '../../../etc/passwd')).toThrow();
    expect(() => buildVoiceSamplePath('../evil', 'abc')).toThrow();
    expect(() => buildVoiceSamplePath('user_1', '')).toThrow();
    expect(() => buildClusterSnippetPath('../x', 0)).toThrow();
    expect(() => buildClusterSnippetPath('s', -1)).toThrow();
    expect(() => buildClusterSnippetPath('s', 1.5)).toThrow();
  });
});
