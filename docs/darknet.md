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
- **Passwords from what the server tells us.** Per neighbour, in order: the server's logs (`heartbleed.js`: a login that
  worked, a passcode a model leaks, passwords known to be wrong, Mastermind replies), then the solvers read the answer
  from the hint, or narrow it down from the replies to wrong guesses (Factori-Os by prime factoring from "divisible"
  feedback within the hint's password length, starting from its "divisible by N" factor; DeepGreen as Mastermind (guesses only the reported length, picks a random remaining candidate so parallel crawlers differ, re-reads the log's earlier replies and "I can see a 8 and a 6" clues before every guess and keeps replies in `data/darknet-mastermind.txt`, so a restarted or second crawler continues instead of repeating); OpenWebAccessPoint returns a captured packet of ~125-145 characters with the password hidden in it on every wrong guess, so the runs of the right length and format common to the captures narrow to the password, usually after two guesses (a `host:password` marker on easy servers is tried at once); PHP 5.4 shows the real password with its characters sorted, so its candidates are the anagrams of Data, capped at 720), and last a few passwords that opened other servers. Blind guessing from fixed
  word lists is out of scope; those passwords can be entered by hand in `data/darknet-passwords.txt`. Other
  feedback-driven models can be added the same way. Logs are read with `peek`, so the lines stay on the server.
- **Only a 401 means a wrong password.** `login` retries 408 timeouts (they happen even with the right
  password); anything else (moved, offline, too little charisma) means "try again on the next re-check",
  not "unsolvable". Skips are counted in the manager's summary so they stay visible.
- **Earning is on by default:** phishing, freeing blocked RAM and opening caches. Freeing RAM is slow
  (about 0.2GB per call), so crawlers keep doing it on their opened neighbours and top up phishing as RAM
  frees.
- **Stasis links go to the servers with the most usable RAM** (max RAM minus blocked), not the most max RAM:
  picking by max RAM chose mostly-blocked servers and never linked anything. Links move to better servers as
  they're found.
- **Push servers to move when mapping stalls (`--no-migrate` turns it off).** Parts of the darknet are cut off from the
  rest, and only a server that moves can carry a crawler across. When no new server has been mapped for 10 minutes, the
  manager lists up to two opened servers (crawler running, not stasis-linked, not stationary) in
  `darknet/migrate-targets.txt` and copies it to every opened server. A crawler next to a target stops phishing, runs
  [`migrate.js`](../darknet/migrate.js) on it with all its free RAM, and phishing resumes when the push ends. Pushes from
  several neighbours stack. The direction a server moves is random, so this is a gamble; any new server clears the list
  and restarts the timer, and a server that stayed put after 4 pushes in a row is left alone until the map grows.
  Timing lives in `MIGRATE` in [`darknet/config.js`](../darknet/config.js). On by default because it only starts once
  ordinary crawling has run dry; rejected: always pushing (it would cost phishing RAM and shuffle servers that are fine
  where they are). Not done: working out which servers sit next to a gap (the API doesn't say), so targets are picked by
  how long since they were last pushed.
- **Never backdoor darknet servers.** Backdoors don't slow server movement. They only let `exec` skip the
  direct-connection check, while each one past two makes any login randomly time out more often and adds
  random restarts that kill our scripts.
- **The manager exits without DarkscapeNavigator.exe**, so it never idles holding RAM. startup.js only
  starts it once the program is owned ([`../darknet/ready.js`](../darknet/ready.js)); before that it kept
  restarting the manager, and each exit left a sticky toast. The exit message is now a normal toast plus a
  terminal line, since it only shows when the manager is run by hand.
- **One implementation, not two.** An earlier alternative design (`darkweb.js`/`scout.js`) was a different design (a scout script on every
  authenticated node, a shared password vault merged on home, `phish.js` filling free RAM). Compared by reading, this one does
  more (stasis links, earnings, restarts, 408 retries, the map), so it stayed the base. Three ideas were taken from the other
  design: the heartbleed log pass, the DeepGreen solver, and trying known passwords on servers whose hint gave nothing. Not
  taken: the controller on home, a blind list of default passwords, and its NIL solver (switched off in that code because
  the server never answered "yes"). The crawler is 0.6GB larger for the heartbleed call.
