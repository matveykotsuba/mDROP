const os = require('os');

function networkInfo(interfaces = os.networkInterfaces()) {
  const candidates = [];
  const excluded = [];
  const vpnLike = /vpn|sstp|pptp|l2tp|wireguard|openvpn|tap|tun|hide[. ]?me|vethernet|virtual|wsl|hamachi|zerotier|radmin|loopback|tailscale|clash|sing-box/i;
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const a of addresses || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
      const [first, second] = a.address.split('.').map(Number);
      const privateAddress = first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
      let reason;
      if (vpnLike.test(name) || a.netmask === '255.255.255.255') reason = 'VPN или виртуальный адаптер';
      else if (a.address.startsWith('169.254.')) reason = 'Нет адреса домашней сети';
      else if (!privateAddress) reason = 'Не частный IPv4-адрес';
      const entry = { name, address: a.address, netmask: a.netmask };
      if (reason) excluded.push({ ...entry, reason });
      else candidates.push(entry);
    }
  }
  const score = (a) => /wi-?fi|wireless|беспроводн/i.test(a.name) ? 20 : /ethernet/i.test(a.name) ? 10 : 0;
  candidates.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
  return { candidates, excluded };
}

function lanAddress() {
  return networkInfo().candidates[0]?.address || 'localhost';
}

module.exports = { networkInfo, lanAddress };
