function parseAddress(from) {
  // from is { name, address }
  return { name: from.name || '', address: from.address };
}

module.exports = { parseAddress };
