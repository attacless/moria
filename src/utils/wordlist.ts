// 256 short, phonetically distinct English words.
// Each word encodes one byte (index 0-255).
// Four words = 4 bytes = 32 bits of verification.
// A MITM who guesses randomly has a 1-in-4-billion chance of matching.

export const wordlist: readonly string[] = [
  // 0-7
  'acid',    'acorn',   'agate',   'amber',   'anchor',  'anvil',   'apex',    'apron',
  // 8-15
  'arbor',   'archer',  'armor',   'arrow',   'aspen',   'atlas',   'attic',   'axle',
  // 16-23
  'badge',   'ballot',  'balm',    'barrel',  'basin',   'beacon',  'bedrock', 'birch',
  // 24-31
  'blade',   'blaze',   'blend',   'block',   'bloom',   'boulder', 'brace',   'branch',
  // 32-39
  'brine',   'brisk',   'bronze',  'brush',   'bucket',  'bugle',   'bulb',    'bundle',
  // 40-47
  'burrow',  'cable',   'cactus',  'canal',   'candle',  'canyon',  'cargo',   'carve',
  // 48-55
  'cedar',   'chalk',   'chant',   'chapel',  'charm',   'chart',   'chase',   'chasm',
  // 56-63
  'chisel',  'chrome',  'circuit', 'citrus',  'clamp',   'clash',   'cleft',   'cliff',
  // 64-71
  'cloak',   'cluster', 'cobalt',  'coil',    'collar',  'comet',   'compass', 'coral',
  // 72-79
  'cord',    'crater',  'crest',   'crimson', 'crypt',   'crystal', 'delta',   'dense',
  // 80-87
  'depth',   'diesel',  'digit',   'discord', 'drift',   'drill',   'drone',   'drought',
  // 88-95
  'dusk',    'dust',    'dwarf',   'echo',    'ember',   'epoch',   'ether',   'fabric',
  // 96-103
  'falcon',  'fathom',  'fault',   'fern',    'finch',   'flare',   'flask',   'flint',
  // 104-111
  'flute',   'foam',    'forge',   'fossil',  'frame',   'frost',   'fuel',    'furrow',
  // 112-119
  'garnet',  'gauge',   'gavel',   'geyser',  'glacier', 'gloom',   'glyph',   'goblet',
  // 120-127
  'gorge',   'grain',   'granite', 'gravel',  'grime',   'grotto',  'harbor',  'harvest',
  // 128-135
  'hazard',  'helm',    'heron',   'hollow',  'husk',    'ibis',    'ingot',   'inlet',
  // 136-143
  'iris',    'iron',    'ivory',   'jade',    'jasper',  'jetty',   'kelp',    'kettle',
  // 144-151
  'kindle',  'knoll',   'kudzu',   'lantern', 'latch',   'lattice', 'ledger',  'lens',
  // 152-159
  'lever',   'linen',   'lintel',  'locket',  'loft',    'lumen',   'luster',  'magnet',
  // 160-167
  'mantle',  'marble',  'marsh',   'marvel',  'mast',    'matrix',  'mesa',    'metal',
  // 168-175
  'mint',    'moat',    'mortar',  'mulch',   'musket',  'nadir',   'needle',  'nickel',
  // 176-183
  'nimbus',  'notch',   'nozzle',  'nugget',  'oaken',   'ochre',   'olive',   'omen',
  // 184-191
  'onyx',    'orbit',   'otter',   'oxen',    'paddle',  'pebble',  'pellet',  'pendant',
  // 192-199
  'pestle',  'petal',   'phantom', 'pigment', 'pillar',  'pincer',  'pixel',   'pivot',
  // 200-207
  'plank',   'plinth',  'plume',   'pocket',  'pollen',  'portal',  'powder',  'prism',
  // 208-215
  'pylon',   'pulsar',  'quartz',  'quorum',  'quench',  'quill',   'rafter',  'rampart',
  // 216-223
  'ravine',  'resin',   'ridge',   'rivet',   'rocket',  'rook',    'rotor',   'rudder',
  // 224-231
  'rune',    'rupture', 'saddle',  'satchel', 'scorch',  'scroll',  'sector',  'sentry',
  // 232-239
  'serpent', 'shale',   'shard',   'shroud',  'sieve',   'signal',  'sinew',   'siren',
  // 240-247
  'slab',    'slate',   'smelt',   'spire',   'splint',  'sprout',  'spur',    'squall',
  // 248-255
  'summit',  'sundial', 'surge',   'thatch',  'timber',  'torque',  'trench',  'zenith',
] as const
