import { hashPassword, verifyPassword } from './passwords.js';

describe('passwords', () => {
  it('verifies the right password and refuses others', async () => {
    const stored = await hashPassword('correct horse battery', 2 ** 12);
    expect(stored).toMatch(/^scrypt\$4096\$/);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batter', stored)).toBe(false);
    expect(await verifyPassword('correct horse battery', 'garbage')).toBe(false);
  });

  it('hashes the same password differently each time', async () => {
    expect(await hashPassword('x'.repeat(8), 2 ** 12)).not.toBe(await hashPassword('x'.repeat(8), 2 ** 12));
  });
});
