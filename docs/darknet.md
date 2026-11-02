# Darknet

[`../darknet/dnet-manager.js`](../darknet/dnet-manager.js) (entry point, on home) seeds
[`crawler.js`](../darknet/crawler.js) onto darkweb; crawlers spread themselves server to server.
Passwords come from [`hint-interpreter.js`](../darknet/hint-interpreter.js) and
[`feedback-solvers.js`](../darknet/feedback-solvers.js); logins go through [`auth.js`](../darknet/auth.js).

## Decisions

- **Crawlers do the work, the manager collects.** A crawler runs on each opened server, reports what it
  sees on port 20, opens its neighbours and copies itself on. Crawlers only report when they start, so the
  manager restarts every known crawler (and phishing worker) on start, reloads the last map, and keeps
  re-checking; the darknet keeps moving servers, so crawlers re-probe their neighbours every minute.
- **Passwords from hints and feedback only.** Solvers read the answer from the server's hint, or narrow it
  down from the server's replies to wrong guesses (Factori-Os is solved by prime factoring from
  "divisible" feedback). Blind guessing from fixed word lists is out of scope; those passwords can be
  entered by hand in `data/darknet-passwords.txt`. Other feedback-driven models can be added the same way.
- **Only a 401 means a wrong password.** `login` retries 408 timeouts (they happen even with the right
  password); anything else (moved, offline, too little charisma) means "try again on the next re-check",
  not "unsolvable". Skips are counted in the manager's summary so they stay visible.
- **Earning is on by default:** phishing, freeing blocked RAM and opening caches. Freeing RAM is slow
  (about 0.2GB per call), so crawlers keep doing it on their opened neighbours and top up phishing as RAM
  frees.
- **Stasis links go to the servers with the most usable RAM** (max RAM minus blocked), not the most max RAM:
  picking by max RAM chose mostly-blocked servers and never linked anything. Links move to better servers as
  they're found.
- **Never backdoor darknet servers.** Backdoors don't slow server movement. They only let `exec` skip the
  direct-connection check, while each one past two makes any login randomly time out more often and adds
  random restarts that kill our scripts.
- **The manager exits without DarkscapeNavigator.exe**, so it never idles holding RAM.
