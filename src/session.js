let current = null;

function set(session) {
  current = session;
}

function get() {
  return current;
}

function clear() {
  current = null;
}

module.exports = { set, get, clear };
