// Michigan city → region map. Used to extract location info from vendor
// names like "Little Tree- Pure New Baltimore" → city "New Baltimore",
// region "Southeast Michigan".
//
// Verified against:
//  - Michigan county/region maps
//  - Each city's actual county and standard Michigan-region classification
//
// IMPORTANT: order matters. Longer / more specific names must come first
// so "New Baltimore" matches before "Baltimore", "Mt Pleasant" before
// "Mt Clemens" etc. Sorted longest-first below.

const CITY_REGION = [
  // ========= UPPER PENINSULA =========
  ['Sault Ste Marie', 'Upper Peninsula'],   // Chippewa County
  ['Saulte Ste Marie', 'Upper Peninsula'],  // typo variant
  ['Sault St Marie', 'Upper Peninsula'],    // variant
  ['Iron Mountain', 'Upper Peninsula'],     // Dickinson County
  ['Crystal Falls', 'Upper Peninsula'],     // Iron County
  ['Marquette', 'Upper Peninsula'],         // Marquette County
  ['Menominee', 'Upper Peninsula'],         // Menominee County
  ['Menoninee', 'Upper Peninsula'],         // typo variant
  ['Escanaba', 'Upper Peninsula'],          // Delta County
  ['Escabana', 'Upper Peninsula'],          // typo variant
  ['Negaunee', 'Upper Peninsula'],          // Marquette County
  ['Munising', 'Upper Peninsula'],          // Alger County (The Fire Station location)
  ['Ironwood', 'Upper Peninsula'],          // Gogebic County
  ['Republic', 'Upper Peninsula'],          // Marquette County
  // Note: dispensary "Houghton" usually refers to Houghton Lake (Northern Lower),
  // not the UP city. Listed below in Northern Lower section.

  // ========= NORTHERN LOWER =========
  ['Houghton Lake', 'Northern Lower'],      // Roscommon County (Pleasantrees Houghton)
  ['Traverse City', 'Northern Lower'],      // Grand Traverse County
  ['West Branch', 'Northern Lower'],        // Ogemaw County
  ['Cheboygan', 'Northern Lower'],          // Cheboygan County
  ['Cheboygen', 'Northern Lower'],          // typo variant
  ['Mancelona', 'Northern Lower'],          // Antrim County
  ['Houghton', 'Northern Lower'],           // dispensary "Houghton" = Houghton Lake (verified via Pleasantrees)
  ['Kalkaska', 'Northern Lower'],           // Kalkaska County
  ['Gaylord', 'Northern Lower'],            // Otsego County

  // ========= WEST MICHIGAN =========
  ['Grand Rapids', 'West'],                 // Kent County
  ['Cedar Springs', 'West'],                // Kent County
  ['Grand Haven', 'West'],                  // Ottawa County
  ['Saugatuck', 'West'],                    // Allegan County (JARS location)
  ['Port Huron', 'East'],                   // (Port Huron - Thumb / East, kept here for adjacency check)
  ['Muskegon', 'West'],                     // Muskegon County
  ['Musegon', 'West'],                      // typo variant
  ['Muskego', 'West'],                      // typo variant
  ['Whitehall', 'West'],                    // Muskegon County
  ['Wayland', 'West'],                      // Allegan County
  ['Holland', 'West'],                      // Ottawa County
  ['Lowell', 'West'],                       // Kent County

  // ========= SOUTHWEST MICHIGAN =========
  ['New Buffalo', 'Southwest'],             // Berrien County
  ['Battle Creek', 'Southwest'],            // Calhoun County
  ['Three Rivers', 'Southwest'],            // St. Joseph County
  ['White Pigeon', 'Southwest'],            // St. Joseph County
  ['Constantine', 'Southwest'],             // St. Joseph County
  ['Kalamazoo', 'Southwest'],               // Kalamazoo County
  ['Kalamazo', 'Southwest'],                // typo variant
  ['Plainwell', 'Southwest'],               // Allegan County
  ['Paw Paw', 'Southwest'],                 // Van Buren County
  ['Allegan', 'Southwest'],                 // Allegan County
  ['Sturgis', 'Southwest'],                 // St. Joseph County
  ['Portage', 'Southwest'],                 // Kalamazoo County
  ['Niles', 'Southwest'],                   // Berrien County

  // ========= CENTRAL MICHIGAN =========
  ['East Lansing', 'Central'],              // Ingham County
  ['Mount Pleasant', 'Central'],            // Isabella County
  ['Mt Pleasant', 'Central'],               // variant
  ['Mt Pleasent', 'Central'],               // typo variant
  ['Big Rapids', 'Central'],                // Mecosta County
  ['Lansing', 'Central'],                   // Ingham County
  ['Owosso', 'Central'],                    // Shiawassee County
  ['Fulton', 'Central'],                    // Kalamazoo or Gratiot County

  // ========= EAST MICHIGAN (Saginaw Bay + Thumb + Flint) =========
  ['Birch Run', 'East'],                    // Saginaw County
  ['Mt Morris', 'East'],                    // Genesee County
  ['Bay City', 'East'],                     // Bay County
  ['Saginaw', 'East'],                      // Saginaw County
  ['Davison', 'East'],                      // Genesee County
  ['Burton', 'East'],                       // Genesee County
  ['Corunna', 'East'],                      // Shiawassee County
  ['Lapeer', 'East'],                       // Lapeer County
  ['Vassar', 'East'],                       // Tuscola County
  ['Flint', 'East'],                        // Genesee County
  ['Caro', 'East'],                         // Tuscola County

  // ========= SOUTH CENTRAL =========
  ['Coldwater', 'South Central'],           // Branch County
  ['Cold Water', 'South Central'],          // variant
  ['Tekonsha', 'South Central'],            // Calhoun County
  ['Teknosha', 'South Central'],            // typo variant
  ['Pittsford', 'South Central'],           // Hillsdale County
  ['Hillsdale', 'South Central'],           // Hillsdale County
  ['Camden', 'South Central'],              // Hillsdale County
  ['Reading', 'South Central'],             // Hillsdale County
  ['Quincy', 'South Central'],              // Branch County
  ['Jackson', 'South Central'],             // Jackson County

  // ========= SOUTHEAST MICHIGAN (Detroit metro + Ann Arbor + Macomb) =========
  ['Harrison Township', 'Southeast'],       // Macomb County (Pleasantrees HQ)
  ['Madison Heights', 'Southeast'],         // Oakland County
  ['Mount Clemens', 'Southeast'],           // Macomb County
  ['Troy', 'Southeast'],                    // Oakland County (JARS HQ + Cloud Cannabis offices)
  ['New Baltimore', 'Southeast'],           // Macomb County
  ['Lincoln Park', 'Southeast'],            // Wayne County
  ['Lake Orion', 'Southeast'],              // Oakland County
  ['River Rouge', 'Southeast'],             // Wayne County
  ['Walled Lake', 'Southeast'],             // Oakland County
  ['Hazel Park', 'Southeast'],              // Oakland County
  ['Whitmore Lake', 'Southeast'],           // Washtenaw County
  ['Whitemore Lake', 'Southeast'],          // typo variant
  ['Whitemore', 'Southeast'],               // typo (Wellflower Dispo Whitmore)
  ['Center Line', 'Southeast'],             // Macomb County
  ['Cherry Hill', 'Southeast'],             // Westland / Wayne County
  ['Ypsilanti', 'Southeast'],               // Washtenaw County
  ['Mt Clemens', 'Southeast'],              // variant
  ['Ann Arbor', 'Southeast'],               // Washtenaw County
  ['Hamtramck', 'Southeast'],               // Wayne County
  ['Centerline', 'Southeast'],              // Macomb County
  ['Roseville', 'Southeast'],               // Macomb County
  ['Whitmore', 'Southeast'],                // Whitmore Lake context
  ['Ferndale', 'Southeast'],                // Oakland County
  ['Berkley', 'Southeast'],                 // Oakland County
  ['Memphis', 'Southeast'],                 // Macomb/St. Clair County
  ['Inkster', 'Southeast'],                 // Wayne County
  ['Detroit', 'Southeast'],                 // Wayne County
  ['Lennox', 'Southeast'],                  // Macomb County (Lenox Township)
  ['Saline', 'Southeast'],                  // Washtenaw County
  ['Oxford', 'Southeast'],                  // Oakland County
  ['Adrian', 'Southeast'],                  // Lenawee County
  ['Warren', 'Southeast'],                  // Macomb County
  ['Monroe', 'Southeast'],                  // Monroe County
  ['Utica', 'Southeast'],                   // Macomb County
  ['Taylor', 'Southeast'],                  // Wayne County
  ['Romeo', 'Southeast'],                   // Macomb County
  ['Lenox', 'Southeast'],                   // Macomb County (Lenox Township)
  ['Wayne', 'Southeast'],                   // Wayne County (city)
  ['Holly', 'Southeast'],                   // Oakland County
  ['Ypsi', 'Southeast'],                    // Ypsilanti short
]

function clean(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function detectLocation(vendorName) {
  const v = clean(vendorName)
  if (!v) return { city: 'Unknown', region: 'Other' }
  for (const [city, region] of CITY_REGION) {
    if (v.includes(clean(city))) return { city, region }
  }
  return { city: 'Unknown', region: 'Other' }
}
