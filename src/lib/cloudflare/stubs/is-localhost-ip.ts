// `is-localhost-ip` probes the address by binding a UDP socket (node:dgram), which never
// completes in workerd and hangs /api/send. Workers only ever see public client IPs, so
// a pure check against private/loopback ranges is enough.
const IP_RANGES = [
  /^(:{2}f{4}:)?10(?:\.\d{1,3}){3}$/,
  /^(:{2}f{4}:)?127(?:\.\d{1,3}){3}$/,
  /^(::f{4}:)?169\.254\.([1-9]|1?\d\d|2[0-4]\d|25[0-4])\.\d{1,3}$/,
  /^(:{2}f{4}:)?(172\.1[6-9]|172\.2\d|172\.3[01])(?:\.\d{1,3}){2}$/,
  /^(:{2}f{4}:)?192\.168(?:\.\d{1,3}){2}$/,
  /^f[cd][\da-f]{2}(::1?$|:[\da-f]{1,4}){1,7}$/,
  /^fe[89ab][\da-f](::1?$|:[\da-f]{1,4}){1,7}$/,
];

const IP_TESTER_RE = new RegExp(`^(${IP_RANGES.map(re => re.source).join('|')})$`);

export default async function isLocalhost(ip: string): Promise<boolean> {
  const value = (ip ?? '').trim().toLowerCase();

  return value === '' || value === 'localhost' || value === '::1' || value === '::' || IP_TESTER_RE.test(value);
}
