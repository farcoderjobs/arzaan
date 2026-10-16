import bcrypt from 'bcryptjs';
const hash = '$2a$12$CjJlvpnVPPMuEz6o3PMTJ.xduB4ivFVoBEEis.V8/yLEJQy9RRrZm';
(async () => {
  for (const p of ['admin123', 'admin1234', 'wrong']) {
    console.log(p, await bcrypt.compare(p, hash));
  }
})();
