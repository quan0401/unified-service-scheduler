import { isProbePath } from './probe-paths';

describe('isProbePath', () => {
  it.each(['/health', '/health/ready', '/metrics'])('excludes %s', (path) => {
    expect(isProbePath(path)).toBe(true);
  });

  it('ignores a query string', () => {
    expect(isProbePath('/metrics?format=prometheus')).toBe(true);
  });

  it.each(['/appointments', '/availability', '/health-check', undefined])('keeps %s', (path) => {
    expect(isProbePath(path)).toBe(false);
  });
});
