import antiping from './antiping.js';
// Same as /security antiping under a second name.
export default { ...antiping, data: { ...antiping.data, name: 'mention', description: 'Same as /security antiping: stop members pinging protected staff' } };
