// Drop simulator with caching
const dropCache = new Map();
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_SIZE = 100; // Maximum number of cached entries
const CLEANUP_INTERVAL = 10 * 60 * 1000; // Cleanup every 10 minutes

// Periodic cleanup of expired cache entries
setInterval(() => {
  cleanupExpiredCache();
}, CLEANUP_INTERVAL);

function cleanupExpiredCache() {
  const now = Date.now();
  const keysToDelete = [];
  
  for (const [key, value] of dropCache.entries()) {
    if (now - value.timestamp >= CACHE_DURATION) {
      keysToDelete.push(key);
    }
  }
  
  keysToDelete.forEach(key => dropCache.delete(key));
  
  if (keysToDelete.length > 0) {
    console.log(`Cleaned up ${keysToDelete.length} expired cache entries`);
  }
}

function evictLRUEntry() {
  // Find the oldest entry (LRU)
  let oldestKey = null;
  let oldestTime = Date.now();
  
  for (const [key, value] of dropCache.entries()) {
    if (value.timestamp < oldestTime) {
      oldestTime = value.timestamp;
      oldestKey = key;
    }
  }
  
  if (oldestKey) {
    dropCache.delete(oldestKey);
    console.log(`Evicted LRU cache entry: ${oldestKey}`);
  }
}

export async function simulateKills(monsterName, killCount) {
  // Check cache first
  const cacheKey = monsterName.toLowerCase();
  const cached = dropCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return runSimulation(cached.data, killCount);
  }
  
  // Fetch drop data from OSRS Wiki
  try {
    // First, search for the monster
    const searchUrl = `https://oldschool.runescape.wiki/api.php?action=query&list=search&srsearch=${encodeURIComponent(monsterName)}&format=json`;
    const searchResponse = await fetch(searchUrl);
    
    if (!searchResponse.ok) {
      throw new Error(`Search API request failed: ${searchResponse.status}`);
    }
    
    const searchData = await searchResponse.json();
    
    if (!searchData.query || !searchData.query.search || !searchData.query.search.length) {
      return { error: `Could not find monster: "${monsterName}"` };
    }
    
    const pageTitle = searchData.query.search[0].title;
    
    // Get the page content with drop tables
    const contentUrl = `https://oldschool.runescape.wiki/api.php?action=query&prop=revisions&titles=${encodeURIComponent(pageTitle)}&rvprop=content&format=json`;
    const contentResponse = await fetch(contentUrl);
    
    if (!contentResponse.ok) {
      throw new Error(`Content API request failed: ${contentResponse.status}`);
    }
    
    const contentData = await contentResponse.json();
    
    if (!contentData.query || !contentData.query.pages) {
      throw new Error('Invalid response format from wiki API');
    }
    
    const pages = contentData.query.pages;
    const pageId = Object.keys(pages)[0];
    
    if (pageId === '-1' || !pages[pageId].revisions) {
      return { error: `Wiki page not found for: "${monsterName}"` };
    }
    
    const content = pages[pageId].revisions[0]['*'];
    
    if (!content) {
      return { error: `No content found for: "${monsterName}"` };
    }
    
    // Parse drop tables from wiki markup
    const dropData = parseDropTables(content, pageTitle);
    
    // Validate that we got some meaningful data
    if (!dropData || (dropData.always.length === 0 && dropData.main.length === 0 && 
                      dropData.uniques.length === 0 && dropData.tertiary.length === 0)) {
      console.warn(`No drop data found for ${monsterName}, using fallback if available`);
      
      // Try some fallback names for common monsters
      const fallbackData = getFallbackDropData(monsterName);
      if (fallbackData) {
        // Cache the fallback data with size limit enforcement
        if (dropCache.size >= MAX_CACHE_SIZE) {
          evictLRUEntry();
        }
        
        dropCache.set(cacheKey, {
          data: fallbackData,
          timestamp: Date.now()
        });
        return runSimulation(fallbackData, killCount);
      }
      
      return { error: `No drop table data found for: "${monsterName}"` };
    }
    
    // Cache the results with size limit enforcement
    if (dropCache.size >= MAX_CACHE_SIZE) {
      evictLRUEntry();
    }
    
    dropCache.set(cacheKey, {
      data: dropData,
      timestamp: Date.now()
    });
    
    return runSimulation(dropData, killCount);
  } catch (error) {
    console.error('Error fetching drop data:', error);
    
    // Try fallback data if API fails
    const fallbackData = getFallbackDropData(monsterName);
    if (fallbackData) {
      console.log(`Using fallback data for ${monsterName}`);
      return runSimulation(fallbackData, killCount);
    }
    
    return { error: `Failed to fetch drop data for "${monsterName}". Please try again.` };
  }
}

function parseDropTables(wikiContent, monsterName) {
  const drops = {
    name: monsterName,
    always: [],
    main: [],
    uniques: [],
    tertiary: [],
    // New fields for configurable mechanics
    mainTableRolls: 1, // Default 1 roll per kill
    uniqueTableRate: null, // Will be extracted from wiki content
    uniqueTableChance: null // Alternative format (e.g., 1/130)
  };
  
  // Enhanced regex patterns for parsing drop tables with fallbacks
  const patterns = {
    // Primary patterns
    dropsLine: /{{DropsLine\|name=([^|]+)\|quantity=([^|]+)\|rarity=([^|}]+)[^}]*}}/g,
    uniqueTable: /''There is a ([\d/]+) chance of hitting the unique drop table/i,
    uniqueTableAlt: /unique drop table.*?([\d/]+)/i,
    mainTableRolls: /main drop table.*?(\d+) times?/i,
    tertiarySection: /===Tertiary===([\s\S]*?)(?:===|{{DropsTableBottom}})/,
    alwaysSection: /===100%===([\s\S]*?)(?:===|{{DropsTableBottom}})/,
    uniquesSection: /===Uniques===([\s\S]*?)(?:===|{{DropsTableBottom}})/,
    
    // Fallback patterns for different wiki formats
    dropsLineAlt1: /{{drops\s*line\|([^|}]+)\|([^|}]+)\|([^|}]+)[^}]*}}/gi,
    dropsLineAlt2: /{{drop\|item=([^|]+)\|quantity=([^|]+)\|rarity=([^|}]+)[^}]*}}/gi,
    dropsLineAlt3: /\|\s*([^|]+)\s*\|\|\s*([^|]+)\s*\|\|\s*([^|]+)/g, // Table format
    
    // Section patterns with variations
    alwaysSectionAlt1: /===\s*Always\s*===([\s\S]*?)(?:===|{{)/i,
    alwaysSectionAlt2: /===\s*100\s*%\s*===([\s\S]*?)(?:===|{{)/i,
    uniquesSectionAlt1: /===\s*Rare\s*drop\s*table\s*===([\s\S]*?)(?:===|{{)/i,
    uniquesSectionAlt2: /===\s*Unique\s*drops?\s*===([\s\S]*?)(?:===|{{)/i,
    tertiarySectionAlt1: /===\s*Tertiary\s*drops?\s*===([\s\S]*?)(?:===|{{)/i,
    
    // More flexible unique table patterns
    uniqueTableAlt2: /(\d+\/\d+).*?chance.*?unique/i,
    uniqueTableAlt3: /unique.*?(\d+\/\d+)/i
  };
  
  // Parse always drops (100%) - try multiple patterns
  let alwaysMatch = wikiContent.match(patterns.alwaysSection) ||
                   wikiContent.match(patterns.alwaysSectionAlt1) ||
                   wikiContent.match(patterns.alwaysSectionAlt2);
  if (alwaysMatch) {
    parseSection(alwaysMatch[1], drops.always, patterns);
  }
  
  // Parse unique drops - try multiple patterns
  let uniquesMatch = wikiContent.match(patterns.uniquesSection) ||
                    wikiContent.match(patterns.uniquesSectionAlt1) ||
                    wikiContent.match(patterns.uniquesSectionAlt2);
  if (uniquesMatch) {
    parseSection(uniquesMatch[1], drops.uniques, patterns);
  }
  
  // Parse tertiary drops - try multiple patterns
  let tertiaryMatch = wikiContent.match(patterns.tertiarySection) ||
                     wikiContent.match(patterns.tertiarySectionAlt1);
  if (tertiaryMatch) {
    parseSection(tertiaryMatch[1], drops.tertiary, patterns);
  }
  
  // Parse unique table mechanics - try multiple patterns
  const uniqueTableMatch = wikiContent.match(patterns.uniqueTable) || 
                           wikiContent.match(patterns.uniqueTableAlt) ||
                           wikiContent.match(patterns.uniqueTableAlt2) ||
                           wikiContent.match(patterns.uniqueTableAlt3);
  if (uniqueTableMatch) {
    const rateStr = uniqueTableMatch[1];
    if (rateStr && rateStr.includes('/')) {
      const [num, denom] = rateStr.split('/').map(n => parseInt(n));
      if (num > 0 && denom > 0) {
        drops.uniqueTableChance = num / denom;
      }
    }
  }
  
  // Parse main table roll count
  const mainRollsMatch = wikiContent.match(patterns.mainTableRolls);
  if (mainRollsMatch) {
    drops.mainTableRolls = parseInt(mainRollsMatch[1]) || 1;
  }
  
  // Set defaults based on monster type
  if (monsterName.toLowerCase().includes('cerberus')) {
    drops.mainTableRolls = 2;
    drops.uniqueTableChance = drops.uniqueTableChance || 1/130;
  }
  
  // Parse main drop table (everything else) - try multiple patterns
  parseMainDropTable(wikiContent, drops, patterns);
  
  // If no drops found, try fallback data for the specific monster
  if (drops.always.length === 0 && drops.main.length === 0 && drops.uniques.length === 0) {
    const fallbackData = getFallbackDropData(monsterName);
    if (fallbackData) {
      return fallbackData;
    }
    // If no fallback exists, return empty drops with the correct name
    drops.name = monsterName;
  }
  
  return drops;
}

function parseSection(sectionContent, targetArray, patterns) {
  if (!sectionContent) return;
  
  // Try primary pattern first
  const dropsLineRegex = /{{DropsLine\|name=([^|]+)\|quantity=([^|]+)\|rarity=([^|}]+)[^}]*}}/g;
  let match;
  let foundItems = 0;
  
  while ((match = dropsLineRegex.exec(sectionContent)) !== null) {
    const [_, itemName, quantity, rarity] = match;
    targetArray.push({
      item: itemName,
      quantity: parseQuantity(quantity),
      rarity: parseRarity(rarity),
      rarityText: rarity
    });
    foundItems++;
  }
  
  // If no items found, try alternative patterns
  if (foundItems === 0) {
    tryAlternativeParsing(sectionContent, targetArray, patterns);
  }
}

function tryAlternativeParsing(content, targetArray, patterns) {
  // Try alternative drop line patterns
  const altPatterns = [
    patterns.dropsLineAlt1,
    patterns.dropsLineAlt2,
    patterns.dropsLineAlt3
  ];
  
  for (const pattern of altPatterns) {
    let match;
    pattern.lastIndex = 0; // Reset regex
    
    while ((match = pattern.exec(content)) !== null) {
      if (match.length >= 4) {
        const [_, itemName, quantity, rarity] = match;
        if (itemName && itemName.trim() && !itemName.includes('=')) {
          targetArray.push({
            item: itemName.trim(),
            quantity: parseQuantity(quantity),
            rarity: parseRarity(rarity),
            rarityText: rarity || 'Unknown'
          });
        }
      }
    }
    
    if (targetArray.length > 0) break; // Stop if we found items
  }
}

function parseMainDropTable(wikiContent, drops, patterns) {
  // Try primary pattern first
  let match;
  patterns.dropsLine.lastIndex = 0;
  let foundItems = 0;
  
  while ((match = patterns.dropsLine.exec(wikiContent)) !== null) {
    const [_, itemName, quantity, rarity] = match;
    
    // Skip if already in other tables
    if (drops.always.some(d => d.item === itemName) ||
        drops.uniques.some(d => d.item === itemName) ||
        drops.tertiary.some(d => d.item === itemName)) {
      continue;
    }
    
    const drop = {
      item: itemName,
      quantity: parseQuantity(quantity),
      rarity: parseRarity(rarity),
      rarityText: rarity
    };
    
    drops.main.push(drop);
    foundItems++;
  }
  
  // If no main drops found, try alternative patterns
  if (foundItems === 0) {
    console.log('Primary pattern failed, trying alternatives for main drop table');
    tryAlternativeParsing(wikiContent, drops.main, patterns);
    
    // Filter out items that are in other sections
    drops.main = drops.main.filter(mainDrop => 
      !drops.always.some(d => d.item === mainDrop.item) &&
      !drops.uniques.some(d => d.item === mainDrop.item) &&
      !drops.tertiary.some(d => d.item === mainDrop.item)
    );
  }
}

function parseQuantity(quantityStr) {
  try {
    if (!quantityStr) return { min: 1, max: 1 };
    
    // Remove notes like "(noted)"
    const cleaned = quantityStr.replace(/\s*\([^)]+\)/g, '').trim();
    
    if (!cleaned) return { min: 1, max: 1 };
    
    if (cleaned.includes('-')) {
      const parts = cleaned.split('-');
      if (parts.length >= 2) {
        const min = parseInt(parts[0]) || 1;
        const max = parseInt(parts[1]) || min;
        return { min: Math.min(min, max), max: Math.max(min, max) };
      }
    }
    
    const qty = parseInt(cleaned) || 1;
    return { min: qty, max: qty };
  } catch (error) {
    console.warn('Error parsing quantity:', quantityStr, error);
    return { min: 1, max: 1 };
  }
}

function parseRarity(rarityStr) {
  try {
    if (!rarityStr) return 128; // Default rare
    
    const cleaned = rarityStr.trim();
    
    // Handle fraction format (e.g., "1/512", "5/130")
    if (cleaned.includes('/')) {
      const parts = cleaned.split('/');
      if (parts.length >= 2) {
        const numerator = parseInt(parts[0]) || 1;
        const denominator = parseInt(parts[1]) || 1;
        if (denominator > 0 && numerator > 0) {
          return denominator / numerator; // Convert to drop rate
        }
      }
    }
    
    // Handle pure numbers
    const numericValue = parseInt(cleaned);
    if (!isNaN(numericValue) && numericValue > 0) {
      return numericValue;
    }
    
    // Handle text rarities (case insensitive)
    const rarityMap = {
      'always': 1,
      'common': 8,
      'uncommon': 32,
      'rare': 128,
      'very rare': 512,
      'very_rare': 512
    };
    
    const lowerRarity = cleaned.toLowerCase();
    return rarityMap[lowerRarity] || 128;
  } catch (error) {
    console.warn('Error parsing rarity:', rarityStr, error);
    return 128; // Default to rare
  }
}

function runSimulation(dropData, killCount) {
  const loot = {};
  const uniqueDrops = [];
  
  console.log(`Simulating ${killCount} kills of ${dropData.name}`);
  
  // Use optimized simulation for large kill counts
  if (killCount > 1000) {
    return runOptimizedSimulation(dropData, killCount, loot, uniqueDrops);
  }
  
  for (let i = 0; i < killCount; i++) {
    const killNumber = i + 1;
    
    // Always drops (100%)
    dropData.always.forEach(drop => {
      const qty = getRandomQuantity(drop.quantity);
      addToLoot(loot, drop.item, qty);
    });
    
    // Main drop table (dynamic number of rolls)
    const rollCount = dropData.mainTableRolls || 1;
    for (let roll = 0; roll < rollCount; roll++) {
      // Pick one drop from main table based on weights
      const mainDrop = selectWeightedDrop(dropData.main);
      if (mainDrop) {
        const qty = getRandomQuantity(mainDrop.quantity);
        addToLoot(loot, mainDrop.item, qty);
      }
    }
    
    // Unique drops (dynamic rate based on monster)
    if (dropData.uniqueTableChance && dropData.uniques.length > 0) {
      if (Math.random() < dropData.uniqueTableChance) {
        // Equal chance for each unique
        const uniqueDrop = dropData.uniques[Math.floor(Math.random() * dropData.uniques.length)];
        if (uniqueDrop) {
          const qty = getRandomQuantity(uniqueDrop.quantity);
          addToLoot(loot, uniqueDrop.item, qty);
          uniqueDrops.push({
            item: uniqueDrop.item,
            killNumber: killNumber,
            rarity: uniqueDrop.rarityText
          });
        }
      }
    } else {
      // Handle individual unique drops with their own rates
      dropData.uniques.forEach(uniqueDrop => {
        if (Math.random() < 1/uniqueDrop.rarity) {
          const qty = getRandomQuantity(uniqueDrop.quantity);
          addToLoot(loot, uniqueDrop.item, qty);
          uniqueDrops.push({
            item: uniqueDrop.item,
            killNumber: killNumber,
            rarity: uniqueDrop.rarityText
          });
        }
      });
    }
    
    // Tertiary drops (independent rolls)
    dropData.tertiary.forEach(drop => {
      if (Math.random() < 1/drop.rarity) {
        const qty = getRandomQuantity(drop.quantity);
        addToLoot(loot, drop.item, qty);
        
        // Track rare tertiary drops
        if (drop.rarity >= 1000) {
          uniqueDrops.push({
            item: drop.item,
            killNumber: killNumber,
            rarity: drop.rarityText
          });
        }
      }
    });
  }
  
  return {
    monsterName: dropData.name,
    killCount,
    loot,
    uniqueDrops
  };
}

function runOptimizedSimulation(dropData, killCount, loot, uniqueDrops) {
  console.log(`Using optimized simulation for ${killCount} kills`);
  
  // Always drops - these happen every kill
  dropData.always.forEach(drop => {
    const avgQuantity = (drop.quantity.min + drop.quantity.max) / 2;
    const totalQuantity = Math.round(avgQuantity * killCount);
    addToLoot(loot, drop.item, totalQuantity);
  });
  
  // Main drop table - use statistical approximation
  const rollCount = dropData.mainTableRolls || 1;
  const totalMainRolls = killCount * rollCount;
  
  if (dropData.main.length > 0) {
    // Pre-calculate weights for better performance
    const dropsWithWeights = dropData.main.map(drop => {
      let weight;
      if (drop.rarityText.includes('/')) {
        weight = parseInt(drop.rarityText.split('/')[0]) || 1;
      } else {
        weight = 1000 / drop.rarity;
      }
      return { drop, weight };
    });
    
    const totalWeight = dropsWithWeights.reduce((sum, item) => sum + item.weight, 0);
    
    // Calculate expected drops for each item
    dropsWithWeights.forEach(({ drop, weight }) => {
      const probability = weight / totalWeight;
      const expectedDrops = totalMainRolls * probability;
      const actualDrops = Math.round(expectedDrops + (Math.random() - 0.5) * Math.sqrt(expectedDrops));
      
      if (actualDrops > 0) {
        const avgQuantity = (drop.quantity.min + drop.quantity.max) / 2;
        const totalQuantity = Math.round(actualDrops * avgQuantity);
        addToLoot(loot, drop.item, totalQuantity);
      }
    });
  }
  
  // Unique drops - simulate these individually since they're rare
  if (dropData.uniqueTableChance && dropData.uniques.length > 0) {
    for (let i = 0; i < killCount; i++) {
      if (Math.random() < dropData.uniqueTableChance) {
        const uniqueDrop = dropData.uniques[Math.floor(Math.random() * dropData.uniques.length)];
        if (uniqueDrop) {
          const qty = getRandomQuantity(uniqueDrop.quantity);
          addToLoot(loot, uniqueDrop.item, qty);
          uniqueDrops.push({
            item: uniqueDrop.item,
            killNumber: i + 1,
            rarity: uniqueDrop.rarityText
          });
        }
      }
    }
  } else {
    // Handle individual unique drops with their own rates
    dropData.uniques.forEach(uniqueDrop => {
      const expectedDrops = killCount / uniqueDrop.rarity;
      const actualDrops = Math.round(expectedDrops + (Math.random() - 0.5) * Math.sqrt(expectedDrops));
      
      for (let i = 0; i < actualDrops; i++) {
        const qty = getRandomQuantity(uniqueDrop.quantity);
        addToLoot(loot, uniqueDrop.item, qty);
        // For large kill counts, just pick random kill numbers for unique drops
        const killNumber = Math.floor(Math.random() * killCount) + 1;
        uniqueDrops.push({
          item: uniqueDrop.item,
          killNumber: killNumber,
          rarity: uniqueDrop.rarityText
        });
      }
    });
  }
  
  // Tertiary drops - use statistical approximation
  dropData.tertiary.forEach(drop => {
    const expectedDrops = killCount / drop.rarity;
    const actualDrops = Math.round(expectedDrops + (Math.random() - 0.5) * Math.sqrt(expectedDrops));
    
    if (actualDrops > 0) {
      const avgQuantity = (drop.quantity.min + drop.quantity.max) / 2;
      const totalQuantity = Math.round(actualDrops * avgQuantity);
      addToLoot(loot, drop.item, totalQuantity);
      
      // Track rare tertiary drops as unique drops
      if (drop.rarity >= 1000) {
        for (let i = 0; i < actualDrops; i++) {
          const killNumber = Math.floor(Math.random() * killCount) + 1;
          uniqueDrops.push({
            item: drop.item,
            killNumber: killNumber,
            rarity: drop.rarityText
          });
        }
      }
    }
  });
  
  return {
    monsterName: dropData.name,
    killCount,
    loot,
    uniqueDrops
  };
}

function getRandomQuantity(quantity) {
  if (quantity.min === quantity.max) {
    return quantity.min;
  }
  return Math.floor(Math.random() * (quantity.max - quantity.min + 1)) + quantity.min;
}

function addToLoot(loot, item, quantity) {
  loot[item] = (loot[item] || 0) + quantity;
}

function selectWeightedDrop(drops) {
  if (!drops.length) return null;
  if (drops.length === 1) return drops[0];
  
  // Calculate weights more consistently
  const dropsWithWeights = drops.map(drop => {
    let weight;
    
    if (drop.rarityText.includes('/')) {
      // For fractional rarities like "5/130", weight is the numerator (relative frequency)
      const numerator = parseInt(drop.rarityText.split('/')[0]) || 1;
      weight = numerator;
    } else {
      // For numeric rarities, weight is inverse of rarity (1/rarity gives probability)
      // Multiply by large number to avoid very small weights
      weight = 1000 / drop.rarity;
    }
    
    return { drop, weight };
  });
  
  // Calculate total weight
  const totalWeight = dropsWithWeights.reduce((sum, item) => sum + item.weight, 0);
  
  if (totalWeight === 0) return drops[0]; // Safety fallback
  
  // Select random drop based on weights
  let random = Math.random() * totalWeight;
  
  for (const item of dropsWithWeights) {
    random -= item.weight;
    if (random <= 0) {
      return item.drop;
    }
  }
  
  // Should never reach here, but safety fallback
  return drops[drops.length - 1];
}

// Fallback drop data for common monsters
function getFallbackDropData(monsterName) {
  const name = monsterName.toLowerCase();
  
  if (name.includes('cerberus')) {
    return getCerberusHardcodedDrops();
  }
  
  // Add more fallback data for common monsters
  if (name.includes('kbd') || name.includes('king black dragon')) {
    return {
      name: 'King Black Dragon',
      mainTableRolls: 1,
      uniqueTableChance: null,
      always: [
        { item: 'Dragon bones', quantity: { min: 1, max: 1 }, rarity: 1, rarityText: 'Always' }
      ],
      uniques: [
        { item: 'Dragon pickaxe', quantity: { min: 1, max: 1 }, rarity: 1500, rarityText: '1/1500' },
        { item: 'Kbd heads', quantity: { min: 1, max: 1 }, rarity: 128, rarityText: '1/128' }
      ],
      main: [
        { item: 'Coins', quantity: { min: 1000, max: 6000 }, rarity: 4, rarityText: 'Common' },
        { item: 'Adamant platebody', quantity: { min: 1, max: 1 }, rarity: 64, rarityText: 'Uncommon' },
        { item: 'Rune longsword', quantity: { min: 1, max: 1 }, rarity: 64, rarityText: 'Uncommon' }
      ],
      tertiary: [
        { item: 'Clue scroll (elite)', quantity: { min: 1, max: 1 }, rarity: 450, rarityText: '1/450' }
      ]
    };
  }
  
  return null;
}

// Hardcoded Cerberus drops based on the wiki data provided
function getCerberusHardcodedDrops() {
  return {
    name: 'Cerberus',
    mainTableRolls: 2,
    uniqueTableChance: 1/130,
    always: [
      { item: 'Infernal ashes', quantity: { min: 1, max: 1 }, rarity: 1, rarityText: 'Always' }
    ],
    uniques: [
      { item: 'Primordial crystal', quantity: { min: 1, max: 1 }, rarity: 520, rarityText: '1/520' },
      { item: 'Pegasian crystal', quantity: { min: 1, max: 1 }, rarity: 520, rarityText: '1/520' },
      { item: 'Eternal crystal', quantity: { min: 1, max: 1 }, rarity: 520, rarityText: '1/520' },
      { item: 'Smouldering stone', quantity: { min: 1, max: 1 }, rarity: 520, rarityText: '1/520' }
    ],
    main: [
      // Weapons and armour
      { item: 'Rune platebody', quantity: { min: 1, max: 1 }, rarity: 26, rarityText: '5/130' },
      { item: 'Rune chainbody', quantity: { min: 1, max: 1 }, rarity: 32.5, rarityText: '4/130' },
      { item: 'Rune 2h sword', quantity: { min: 1, max: 1 }, rarity: 32.5, rarityText: '4/130' },
      { item: "Black d'hide body", quantity: { min: 1, max: 1 }, rarity: 43.33, rarityText: '3/130' },
      { item: 'Rune axe', quantity: { min: 1, max: 1 }, rarity: 43.33, rarityText: '3/130' },
      { item: 'Rune pickaxe', quantity: { min: 1, max: 1 }, rarity: 43.33, rarityText: '3/130' },
      { item: 'Battlestaff', quantity: { min: 6, max: 6 }, rarity: 43.33, rarityText: '3/130' },
      { item: 'Rune full helm', quantity: { min: 1, max: 1 }, rarity: 43.33, rarityText: '3/130' },
      { item: 'Lava battlestaff', quantity: { min: 1, max: 1 }, rarity: 65, rarityText: '2/130' },
      { item: 'Rune halberd', quantity: { min: 1, max: 1 }, rarity: 65, rarityText: '2/130' },
      // Runes and ammunition
      { item: 'Fire rune', quantity: { min: 300, max: 300 }, rarity: 21.67, rarityText: '6/130' },
      { item: 'Soul rune', quantity: { min: 100, max: 100 }, rarity: 21.67, rarityText: '6/130' },
      { item: 'Pure essence', quantity: { min: 300, max: 300 }, rarity: 26, rarityText: '5/130' },
      { item: 'Blood rune', quantity: { min: 60, max: 60 }, rarity: 32.5, rarityText: '4/130' },
      { item: 'Cannonball', quantity: { min: 50, max: 50 }, rarity: 32.5, rarityText: '4/130' },
      { item: 'Runite bolts (unf)', quantity: { min: 40, max: 40 }, rarity: 32.5, rarityText: '4/130' },
      { item: 'Death rune', quantity: { min: 100, max: 100 }, rarity: 43.33, rarityText: '3/130' },
      // Other
      { item: 'Coal', quantity: { min: 120, max: 120 }, rarity: 21.67, rarityText: '6/130' },
      { item: 'Super restore(4)', quantity: { min: 2, max: 2 }, rarity: 21.67, rarityText: '6/130' },
      { item: 'Summer pie', quantity: { min: 3, max: 3 }, rarity: 21.67, rarityText: '6/130' },
      { item: 'Coins', quantity: { min: 10000, max: 20000 }, rarity: 26, rarityText: '5/130' },
      { item: 'Dragon bones', quantity: { min: 20, max: 20 }, rarity: 26, rarityText: '5/130' },
      { item: 'Unholy symbol', quantity: { min: 1, max: 1 }, rarity: 26, rarityText: '5/130' },
      { item: 'Wine of zamorak', quantity: { min: 15, max: 15 }, rarity: 26, rarityText: '5/130' },
      { item: 'Ashes', quantity: { min: 50, max: 50 }, rarity: 32.5, rarityText: '4/130' },
      { item: 'Fire orb', quantity: { min: 20, max: 20 }, rarity: 32.5, rarityText: '4/130' },
      { item: 'Grimy torstol', quantity: { min: 6, max: 6 }, rarity: 32.5, rarityText: '4/130' },
      { item: 'Runite ore', quantity: { min: 5, max: 5 }, rarity: 43.33, rarityText: '3/130' },
      { item: 'Uncut diamond', quantity: { min: 5, max: 5 }, rarity: 43.33, rarityText: '3/130' },
      { item: 'Torstol seed', quantity: { min: 3, max: 3 }, rarity: 65, rarityText: '2/130' },
      { item: 'Ranarr seed', quantity: { min: 2, max: 2 }, rarity: 65, rarityText: '2/130' },
      { item: 'Key master teleport', quantity: { min: 7, max: 7 }, rarity: 65, rarityText: '2/130' }
    ],
    tertiary: [
      { item: 'Ensouled hellhound head', quantity: { min: 1, max: 1 }, rarity: 15, rarityText: '1/15' },
      { item: 'Clue scroll (elite)', quantity: { min: 1, max: 1 }, rarity: 100, rarityText: '1/100' },
      { item: 'Jar of souls', quantity: { min: 1, max: 1 }, rarity: 2000, rarityText: '1/2000' },
      { item: 'Hellpuppy', quantity: { min: 1, max: 1 }, rarity: 3000, rarityText: '1/3000' }
    ]
  };
}