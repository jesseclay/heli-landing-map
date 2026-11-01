// Each region the map covers: where its data lives, how the map opens, and the local details the app needs.
// bounds are the data's [west, south, east, north]; examples are [label, [lat, lon] or { land: name }, zoom, level].
// parcels names the public parcel services the page asks, live, for property lines and the owner of a clicked spot:
// sources are tried in order (a locality's own first, where it has one); f maps each service's field names.
window.HELI_REGIONS = (() => {
  // Texas's statewide parcels (TxGIO StratMap), compiled from every county appraisal district's roll. The layer's
  // query operation is off, so lookups use identify
  const TXGIO = 'https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer';
  // Virginia's statewide parcels (VGIN): boundaries and parcel IDs, no owners
  const VGIN = 'https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Parcels';
  return {
    austin: {
      key: 'austin', label: 'Austin, TX', name: 'Austin', state: 'TX', data: 'data/austin.js',
      title: 'Austin Helicopter Landing Map',
      bounds: [-98.95, 29.55, -96.85, 31.25],
      view: [30.29, -97.79], zoom: 10.5, zoomSmall: 9.5,
      maxBounds: [[29.2, -99.4], [31.6, -96.4]],
      attribution: 'Data: FAA, USGS PAD-US 4.1, US Census TIGER, EIA, USACE NID, City of Austin',
      dataNote: 'FAA ADDS (airspace, airports, special-use airspace), USGS PAD-US 4.1 (parks and protected land), US Census TIGER (city limits, roads, water, campuses, correctional facilities), EIA (power plants), USACE National Inventory of Dams (high-hazard dams), City of Austin (zoning)',
      major: ['Austin', 'Round Rock', 'Georgetown', 'San Marcos', 'Cedar Park', 'Pflugerville', 'New Braunfels', 'Killeen', 'Temple', 'Leander', 'Kyle', 'Bastrop', 'Lockhart', 'Marble Falls', 'Taylor', 'Fredericksburg', 'Seguin', 'Lakeway', 'Dripping Springs', 'Burnet', 'Llano', 'Elgin', 'Giddings'],
      waterLabels: [
        ['Lake Travis', 30.4378, -97.9200, ''], ['Lake Austin', 30.3511, -97.8070, ''], ['Lady Bird Lake', 30.2617, -97.7450, ''],
        ['Lake LBJ', 30.5710, -98.3600, ''], ['Lake Buchanan', 30.7872, -98.4100, ''], ['Inks Lake', 30.7470, -98.3880, 'minor'],
        ['Lake Marble Falls', 30.5546, -98.3000, 'minor'], ['Canyon Lake', 29.8928, -98.2600, ''], ['Lake Georgetown', 30.6741, -97.7500, 'minor'],
        ['Granger Lake', 30.6950, -97.3500, 'minor'], ['Lake Bastrop', 30.1565, -97.2900, 'minor'], ['Walter E. Long Lake', 30.3032, -97.6000, 'minor'],
        ['Belton Lake', 31.1396, -97.5200, ''], ['Stillhouse Hollow Lake', 31.0149, -97.6100, 'minor'],
      ],
      // city limits the build tags with a reg key, and the rule and map tint each one gets
      cities: {
        austin: { rule: 'city_austin', tint: 'amber' },
        wlh: { rule: 'city_wlh', tint: 'red' },
        lakeway: { rule: 'city_lakeway', tint: 'red' },
        dripping: { rule: 'city_dripping', tint: 'red' },
        hsb: { rule: 'city_hsb', tint: 'amber' },
        zoning: { rule: 'city_zoning', tint: '' },
      },
      cityNotes: {
        Georgetown: 'heliports are banned in agricultural, residential and neighborhood commercial districts; elsewhere only beside a hospital or government facility, or by special use permit (UDC §5.05.020)',
        Kyle: 'heliports by conditional use only, in the CM, W and PUD districts (§53-1047)',
        Buda: 'special use permit only, and not within 1,000 ft of a church, school, hospital, library, park or home without noise mitigation (UDC §2.06.06)',
        'Cedar Park': 'accessory heliports only in the H, PS and PA districts (§11.02.064)',
        'Marble Falls': 'rotary-wing aviation is a conditional use in a few commercial and industrial districts (Development Code Table 3.1.4)',
        Leander: 'any landing field needs a special use permit (zoning Art. IV §2)',
        'Round Rock': 'zoning provides only for hospital heliports (§§2-60, 2-91)',
      },
      airportRadius: { AUS: 2700, SAT: 2300, GRK: 2000 },
      airspaceNames: { AUS: 'Austin-Bergstrom', SAT: 'San Antonio' },
      hideAirspaceLabels: ['SAT', 'RND'],
      examples: [
        ['Zilker Park', { land: 'Zilker Metro Park' }, 14, 'red'],
        ['Backyard in Hyde Park', [30.3050, -97.7292], 15, 'red'],
        ['Industrial zoning in North Austin', [30.4000, -97.7200], 15, 'amber'],
        ['Ranch land near Dripping Springs', [30.2290, -98.2140], 12, 'green'],
        ['Backyard in West Lake Hills', [30.2953, -97.8124], 14, 'red'],
        ['Lake Travis', [30.4378, -97.9200], 12, 'amber'],
        ['Austin Executive Airport', [30.3975, -97.5664], 13, 'blue'],
        ['UT campus', { land: 'University of Texas at Austin' }, 14, 'red'],
        ['Pedernales Falls State Park', { land: 'Pedernales Falls State Park' }, 12, 'red'],
        ['Balcones Canyonlands refuge', { land: 'Balcones Canyonlands National Wildlife Refuge' }, 11, 'red'],
        ['Dell Children’s hospital helipad', [30.30440, -97.70773], 15, 'amber'],
      ],
      parcels: {
        lines: { kind: 'export', url: TXGIO, layer: 0, label: 'owner_name', labelArea: 'gis_area', minZoom: 15, legend: 'Property lines and owners' },
        sources: [{
          state: 'TX', op: 'identify', url: TXGIO, layer: 0,
          f: { owner: 'OWNER_NAME', care: 'NAME_CARE', mail: ['MAIL_LINE1', 'MAIL_LINE2'], mailCity: 'MAIL_CITY', mailState: 'MAIL_STAT', mailZip: 'MAIL_ZIP', mailFull: 'MAIL_ADDR', situs: 'SITUS_ADDR', id: 'PROP_ID', legal: 'LEGAL_DESC', county: 'COUNTY', year: 'TAX_YEAR' },
          // each appraisal district's page for one property, by its property ID
          records: {},
        }],
        business: { TX: ['Texas business records', 'https://comptroller.texas.gov/taxes/franchise/account-status/search'] },
        note: 'Property lines and owners are looked up live from TxGIO’s statewide parcel layer, which the state compiles from each county appraisal district’s roll',
      },
    },
    blacksburg: {
      key: 'blacksburg', label: 'Blacksburg, VA', name: 'Blacksburg', state: 'VA', data: 'data/blacksburg.js',
      title: 'Blacksburg Helicopter Landing Map',
      bounds: [-81.05, 36.80, -79.70, 37.55],
      view: [37.22, -80.33], zoom: 10.5, zoomSmall: 9.5,
      maxBounds: [[36.45, -81.5], [37.9, -79.25]],
      attribution: 'Data: FAA, USGS PAD-US 4.1, US Forest Service, US Census TIGER, EIA, USACE NID',
      dataNote: 'FAA ADDS (airspace, airports, special-use airspace), USGS PAD-US 4.1 (parks and protected land), US Forest Service (wilderness boundaries), US Census TIGER (town and city limits, roads, water, campuses, correctional facilities), EIA (power plants), USACE National Inventory of Dams (high-hazard dams)',
      major: ['Blacksburg', 'Christiansburg', 'Radford', 'Roanoke', 'Salem', 'Pulaski', 'Pearisburg', 'Floyd', 'Dublin', 'Vinton', 'Narrows'],
      waterLabels: [
        ['Claytor Lake', 37.0657, -80.6442, ''], ['New River', 37.2974, -80.6416, 'minor'], ['Smith Mountain Lake', 37.1528, -79.6733, 'minor'],
        ['Carvins Cove', 37.3773, -79.9509, 'minor'], ['Mountain Lake', 37.3588, -80.5353, 'minor'], ['Philpott Lake', 36.8140, -80.0590, 'minor'],
        ['Roanoke River', 37.2430, -80.1437, 'minor'], ['Gatewood Reservoir', 37.0437, -80.8810, 'minor'],
      ],
      // Virginia bars a total zoning ban on personal helicopter landings, so most towns get a green rule; Roanoke and
      // Salem define any landing spot as an airport or aviation facility, so they're tinted
      cities: {
        blacksburg: { rule: 'city_blacksburg', tint: '' },
        christiansburg: { rule: 'city_christiansburg', tint: '' },
        radford: { rule: 'city_radford', tint: '' },
        pulaski: { rule: 'city_pulaski', tint: '' },
        pearisburg: { rule: 'city_pearisburg', tint: '' },
        roanoke: { rule: 'city_roanoke', tint: 'amber' },
        salem: { rule: 'city_salem', tint: 'amber' },
      },
      countyRules: { 'Montgomery County': 'county_montgomery', 'Roanoke County': 'county_roanoke', 'Pulaski County': 'county_pulaski', 'Giles County': 'county_giles', 'Floyd County': 'county_floyd' },
      countyParkRules: { 'Roanoke County': 'park_roanoke_county' },
      airportRadius: { ROA: 1800, BCB: 900, PSK: 900 },
      airspaceNames: { ROA: 'Roanoke–Blacksburg' },
      examples: [
        ['Backyard in Blacksburg', [37.2400, -80.4100], 15, 'amber'],
        ['Backyard in Christiansburg', [37.1350, -80.4000], 15, 'green'],
        ['Virginia Tech Drillfield', { land: 'Drillfield' }, 15, 'amber'],
        ['Farm in rural Montgomery County', [37.1000, -80.2900], 13, 'green'],
        ['Jefferson National Forest', [37.3000, -80.3800], 13, 'green'],
        ['Mountain Lake Wilderness', { land: 'Mountain Lake Wilderness' }, 12, 'red'],
        ['McAfee Knob (Appalachian Trail)', [37.3925, -80.0365], 14, 'red'],
        ['Claytor Lake State Park', { land: 'Claytor Lake State Park' }, 13, 'red'],
        ['Virginia Tech Airport', [37.2076, -80.4078], 14, 'blue'],
        ['Radford Army Ammunition Plant', { land: 'Radford Army Ammunition Plant' }, 12, 'red'],
        ['New River', [37.2974, -80.6416], 14, 'amber'],
      ],
      // Virginia publishes owners county by county; each locality's own layer comes first, VGIN's statewide parcel IDs
      // after it. Giles, Floyd, Carroll, Bland, Patrick, Henry and Wythe show owners only in viewers behind a terms page
      parcels: {
        lines: { kind: 'tiles', url: `${VGIN}/MapServer`, minZoom: 15, legend: 'Property lines' },
        sources: [
          { state: 'VA', only: ['Montgomery County'], op: 'query', url: 'https://maps.montva.com/server/rest/services/Land/Parcels_Public/MapServer', layer: 1,
            title: 'Montgomery County real estate records', link: 'https://realestate.montva.com/Datalets/Datalet.aspx?mode=profileall&UseSearch=no&pin={id}',
            f: { owner: ['OWNER1', 'OWNER2'], mail: ['MAIL_ADD1', 'MAIL_ADD2'], situs: ['SITE_ADD1'], id: 'PARCEL_ID', alt: 'TAX_MAP_ID', legal: ['LEGAL1', 'LEGAL2'] } },
          { state: 'VA', only: ['City of Radford'], op: 'query', url: 'https://services2.arcgis.com/uBVNRnvxMutOfx4V/ArcGIS/rest/services/Real_Estate_2025/FeatureServer', layer: 2,
            title: 'City of Radford real estate records', linkField: 'PROPERTY_CARD_LINK', linkLabel: 'Property card',
            f: { owner: ['OWNER', 'OWNER_ALT'], mail: ['OWNER_STREET'], mailCity: 'OWNER_CITY', mailState: 'OWNER_STATE', mailZip: 'OWNER_ZIP', situs: ['PROPERTY_ADDRESS'], id: 'PIN', legal: 'LEGAL' } },
          { state: 'VA', only: ['Pulaski County'], op: 'query', url: 'https://services5.arcgis.com/cnJiyVVCFyUslPPa/arcgis/rest/services/ParcelUpdate_2026/FeatureServer', layer: 2,
            title: 'Pulaski County parcel records',
            f: { owner: ['owner1', 'owner2'], mail: ['own_street'], mailCity: 'own_city', mailState: 'own_state', mailZip: 'own_zip', situs: ['prop_stree'], id: 'Parc_lbl', legal: 'leg_descri' } },
          { state: 'VA', only: ['Roanoke County'], op: 'query', url: 'https://arcgis.roanokecountyva.gov/arcgisweb/rest/services/Published_Geodata/RealEstate/MapServer', layer: 24,
            title: 'Roanoke County real estate records',
            f: { owner: ['Owner1_LastAndFirst', 'Owner2_LastAndFirst'], shielded: 'OwnerInfoIsProtected', mail: ['MailingAddressLine1', 'MailingAddressLine2', 'MailingAddressLine3'], mailZip: 'MailingAddressZipCode', situs: ['LocationAddressForDisplay'], id: 'ParcelID', legal: 'LegalDescription' } },
          { state: 'VA', only: ['City of Roanoke'], op: 'query', url: 'https://gis03.roanokeva.gov/arcgis/rest/services/Public/Parcels/FeatureServer', layer: 0,
            title: 'City of Roanoke real estate records', link: 'https://www.webgis.net/va/roanokecity/?id=Parcels|TAXID|{TAXID}', linkLabel: 'City parcel map',
            f: { owner: ['OWNER', 'OWNER2'], mail: ['OWNERADDR1'], mailCity: 'MAILCITY', mailState: 'MAILSTATE', mailZip: 'MAINZIPCOD', situs: ['LOCADDR'], id: 'TAXID', legal: 'LEGALDESC' } },
          { state: 'VA', only: ['City of Salem'], op: 'query', url: 'https://services7.arcgis.com/RL8aZgZHmJOdyNXk/arcgis/rest/services/TaxParcels/FeatureServer', layer: 5,
            title: 'City of Salem real estate records', link: 'https://gis.vgsi.com/salemva/Parcel.aspx?pid={PID}', linkLabel: 'City records search',
            f: { owner: ['owner'], mail: ['owner_address1', 'owner_address2'], mailCity: 'owner_city_state', mailZip: 'owner_zip', situs: ['FullAddress'], id: 'GPIN', alt: 'tax_map_number', legal: 'legal_description' } },
          { state: 'VA', only: ['Craig County'], op: 'query', url: 'https://www.webgis.net/arcgis/rest/services/VA/Craig_WebGIS/MapServer', layer: 10,
            title: 'Craig County parcel records', link: 'https://www.webgis.net/linkedfiles/va/craig/?lrsn={lrsn}', linkLabel: 'Property card',
            f: { owner: ['OwnerName1', 'OwnerName2'], mail: ['OwnerAddress1', 'OwnerAddress2'], mailCity: 'OwnerCity', mailState: 'OwnerState', mailZip: 'OwnerZip', situs: ['PropertyStreet'], id: 'parcel_id', alt: 'HPLabel', legal: ['Legal_1', 'Legal_2'] } },
          { state: 'VA', only: ['Botetourt County'], op: 'query', url: 'https://services6.arcgis.com/6h5xc2eGkGuRiFia/arcgis/rest/services/Parcels/FeatureServer', layer: 3,
            title: 'Botetourt County parcel records', link: 'https://www.webgis.net/va/botetourtco/pc2/?pid={RPC}', linkLabel: 'Property card',
            f: { owner: ['Owner1'], care: ['Owner2'], mail: ['MailAddr', 'MailAddr2'], mailCity: 'MailCity', mailState: 'MailStat', mailZip: 'MailZip', situs: ['LocAddr'], id: 'RPC', alt: 'LINK', legal: 'Legal1' } },
          { state: 'VA', only: ['Franklin County'], op: 'query', url: 'https://gis.franklincountyva.gov/arcgis/rest/services/PublicServices/UpdatedWebParcels/MapServer', layer: 0,
            title: 'Franklin County parcel records', linkField: 'CARD_URL', linkLabel: 'Property card',
            f: { owner: ['owner_name'], mail: ['owner_address'], mailCity: 'owner_city', mailState: 'owner_state', mailZip: 'owner_zip', situs: ['FULLADDR'], id: 'PIN', legal: ['legal_description_1', 'legal_description_2'] } },
          { state: 'VA', only: ['Bedford County'], op: 'query', url: 'https://webgis.bedfordcountyva.gov/arcgis/rest/services/OpenData/OpenDataProperty/MapServer', layer: 6,
            title: 'Bedford County parcel records',
            f: { owner: ['Owner1', 'Owner2'], mail: ['MailAddr'], mailCity: 'MailCity', mailState: 'MailStat', mailZip: 'MailZip', situs: ['LocAddr'], id: 'PIN', legal: 'legal_desc' } },
          { state: 'VA', only: ['Grayson County'], op: 'query', url: 'https://www.webgis.net/arcgis/rest/services/VA/GraysonCo_WebGIS1/MapServer', layer: 19,
            title: 'Grayson County parcel records', link: 'https://gis.vgsi.com/graysoncountyva/Parcel.aspx?pid={PID}',
            f: { owner: ['MLNAM', 'MFNAM'], mail: ['MADD1', 'MADD2'], mailCity: 'MCITY', mailState: 'MSTATE', mailZip: 'MZIP5', situs: [['MHSE_', 'MSTRT']], id: 'PID', alt: 'LABEL', legal: 'MDESC1' } },
          { state: 'VA', op: 'query', url: `${VGIN}/FeatureServer`, layer: 0, title: '{loc} parcels (statewide map)', f: { id: 'PARCELID', alt: 'PTM_ID' } },
          // West Virginia's statewide parcels; the layer says it was last updated for tax year 2023, so the record link
          // (the state's current assessment page) is the one to trust
          { state: 'WV', op: 'query', url: 'https://services.wvgis.wvu.edu/arcgis/rest/services/Planning_Cadastre/WV_Parcels/MapServer', layer: 0,
            title: 'West Virginia parcels, tax year 2023', link: 'https://mapwv.gov/Assessment/Detail/?PID={CleanParcelID}', linkLabel: 'Current WV assessment',
            f: { owner: ['FullOwnerName'], mailFull: ['FullOwnerAddress'], situs: ['FullPhysicalAddress'], id: 'GISPID', legal: 'FullLegalDescription' } },
        ],
        viewers: {
          'Giles County': ['Giles County parcel map', 'https://gilescova.interactivegis.com/map/'],
          'Floyd County': ['Floyd County parcel map', 'https://floyd.interactivegis.com/'],
          'Carroll County': ['Carroll County parcel map', 'https://carrollcova.interactivegis.com/map/'],
          'Bland County': ['Bland County parcel map', 'https://blandcova.interactivegis.com/'],
          'Patrick County': ['Patrick County parcel map', 'https://patcova.interactivegis.com/'],
          'Henry County': ['Henry County parcel map', 'https://henrycova.interactivegis.com/map/'],
          'Wythe County': ['Wythe County parcel map', 'https://wythecova.interactivegis.com/map/'],
        },
        business: { VA: ['Virginia business records', 'https://cis.scc.virginia.gov/EntitySearch/Index'], WV: ['West Virginia business records', 'https://apps.sos.wv.gov/business/corporations/'] },
        note: 'Property lines come from VGIN’s statewide parcel map; owners are looked up live from each county’s or city’s own parcel layer where it publishes one, and from West Virginia’s statewide parcels (last updated for tax year 2023)',
      },
    },
  };
})();
