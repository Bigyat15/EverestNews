// TEST FIXTURES ONLY. Fictional events written for tests; never inserted into a real database.
export const EN_PARAS = [
  'KAILALI, Oct 19 — The Ministry of Physical Infrastructure has awarded a Rs 45 million contract to rebuild the Mohana River bridge, which was washed away by floods on September 28, officials said on Sunday.',
  'Ram Bahadur Thapa, chief of the District Infrastructure Office, said the new 120-metre bridge will serve 320 households in three wards that have been cut off for three weeks. "We expect the bridge to open before the monsoon next year," Thapa said.',
  'According to the office, work will begin on November 10 and employ about 60 local workers. A temporary footbridge, 12 km upstream, will remain in use until then.',
  'Local resident Sita Chaudhary said children had walked two hours to reach school since the flood. The ward chair, Hari Prasad Joshi, said villagers had asked for a permanent solution for years.',
  'The contractor, Himal Construction, has promised to complete 70 percent of the foundation work before the end of the year, the office said.',
];
export const EN_TEXT = EN_PARAS.join('\n\n'), EN_TITLE = 'Kailali flood bridge contract awarded', EN_SUMMARY = EN_PARAS[0];
export const EN_QUOTE = 'We expect the bridge to open before the monsoon next year';

export const NE_PARAS = [
  'कैलाली, ३ कात्तिक — सेप्टेम्बर २८ मा आएको बाढीले बगाएको मोहना नदीको पुल फेरि बनाउन भौतिक पूर्वाधार मन्त्रालयले ४५ मिलियन रुपैयाँको ठेक्का स्वीकृत गरेको अधिकारीहरूले आइतबार जनाएका छन्।',
  'जिल्ला पूर्वाधार कार्यालय प्रमुख रामबहादुर थापाले नयाँ १२० मिटरे पुलले तीन हप्तादेखि सम्पर्कविहीन तीन वडाका ३२० घरपरिवारलाई फेरि जोड्ने बताए। "आगामी वर्षको वर्षाअघि पुल सञ्चालनमा आउने अपेक्षा गरेका छौँ," थापाले भने।',
  'कार्यालयका अनुसार नोभेम्बर १० मा काम शुरू गरिनेछ र करिब ६० स्थानीयले रोजगारी पाउनेछन्। तबसम्म माथिल्लो भेगमा १२ किलोमिटर टाढाको अस्थायी झोलुङ्गे पुल नै भरपर्दो बाटो रहनेछ।',
  'सीता चौधरी भन्छिन्, बाढी आएदेखि विद्यालय पुग्न बालबालिकाले दुई घण्टा पैदल हिँड्नुपर्छ। वडाध्यक्ष हरिप्रसाद जोशीका अनुसार गाउँलेले धेरै वर्षदेखि स्थायी पुलको माग गर्दै आएका थिए।',
  'निर्माण कम्पनी हिमाल कन्स्ट्रक्सनले यस वर्षभित्रै जगको ७० प्रतिशत काम सक्ने वाचा गरेको कार्यालयको भनाइ छ।',
  'स्थानीयले काम समयमै सकियोस् भन्ने उद्देश्यले सम्बन्धित निकायले नियमित निगरानी गरून् भन्ने माग राखेका छन्। सडक सम्पर्क टुटेपछि बजार, स्वास्थ्य सेवा र विद्यालय पुग्न कठिनाइ भएको उनीहरू बताउँछन्।',
];
export const NE_TEXT = NE_PARAS.join('\n\n'), NE_TITLE = 'कैलालीको बाढीले बगाएको पुलको ठेक्का', NE_SUMMARY = NE_PARAS[0];
export const NE_QUOTE = 'आगामी वर्षको वर्षाअघि पुल सञ्चालनमा आउने अपेक्षा गरेका छौँ';

const URL_TOKEN = '{{ARTICLE_URL}}';
export const EN_ED = {
  headline: 'Contract awarded to rebuild flood-hit Mohana River bridge in Kailali', headline_alternatives: ["Kailali's Mohana bridge to be rebuilt after flood", 'Rs 45 million contract for new Mohana bridge'],
  standfirst: 'The Ministry of Physical Infrastructure has awarded a Rs 45 million contract for a new 120-metre bridge that will reconnect 320 households cut off since the September 28 flood.',
  body: ['A Rs 45 million deal to replace the Mohana River bridge in Kailali has been signed by the Ministry of Physical Infrastructure, three weeks after the September 28 floods carried the old crossing away, officials announced on Sunday.',
    'Ram Bahadur Thapa, who heads the District Infrastructure Office, said the 120-metre replacement will reconnect 320 households spread across three wards that have had no direct road link since the disaster. “We expect the bridge to open before the monsoon next year,” Thapa said.',
    '## Work to begin in November', 'Building is due to start on November 10, giving jobs to roughly 60 people from nearby villages, the office said. In the meantime, people must rely on a temporary footbridge 12 km upstream.',
    'The detour has been hardest on children. Local resident Sita Chaudhary said pupils have spent two hours a day walking to school since the flood, and ward chair Hari Prasad Joshi noted that residents had been campaigning for a lasting crossing for years.',
    'Himal Construction, the firm that won the contract, has pledged that 70 percent of the foundation will be done by the end of the year, according to the office.'].join('\n\n'),
  graphic_headline: 'Kailali flood bridge to be rebuilt', graphic_description: 'A Rs 45 million contract will reconnect 320 households cut off since the flood.',
  social_caption: `Three weeks after floods swept away the Mohana River bridge in Kailali, a Rs 45 million rebuilding contract has finally been awarded. The new 120-metre bridge will reconnect 320 households in three wards, according to the District Infrastructure Office. Construction starts on November 10 with about 60 local workers, and the office expects the bridge to open before next year's monsoon. Until then a temporary footbridge 12 km upstream is the only crossing, and children have been walking two hours to get to school.\n${URL_TOKEN}\n#Kailali #Nepal #Infrastructure #FloodRecovery`,
  short_caption: "Rs 45 million contract awarded to rebuild Kailali's flood-hit Mohana bridge; 320 households have been cut off for three weeks. #Kailali",
  seo_title: 'Kailali Mohana bridge to be rebuilt in Rs 45 million deal', meta_description: 'A Rs 45 million contract will rebuild the flood-hit Mohana River bridge in Kailali, reconnecting 320 households. Work starts November 10.',
  keywords: ['Kailali', 'Mohana River bridge', 'flood', 'infrastructure', 'Nepal'], hashtags: ['#Kailali', '#Nepal', '#Infrastructure'], alt_text: 'Everest News graphic about the Mohana River bridge reconstruction in Kailali',
};
export const NE_ED = {
  headline: 'कैलालीको बाढीले बगाएको मोहना पुल पुनर्निर्माणको ठेक्का सम्झौता', headline_alternatives: ['कैलालीमा मोहना नदीमा नयाँ पुल बन्ने', '४५ मिलियन रुपैयाँको ठेक्कामा मोहना पुल बन्दै'],
  standfirst: 'भौतिक पूर्वाधार मन्त्रालयले सेप्टेम्बर २८ को बाढीपछि विच्छेदित ३२० घरधुरीलाई जोड्ने १२० मिटर लामो नयाँ पुलका लागि ४५ मिलियन रुपैयाँको ठेक्का दिएको छ।',
  body: ['भौतिक पूर्वाधार मन्त्रालयले सेप्टेम्बर २८ मा बाढीले बगाएको कैलालीको मोहना नदीको पुल पुनर्निर्माणका लागि ४५ मिलियन रुपैयाँको ठेक्का दिएको अधिकारीहरूले आइतबार जानकारी दिए।',
    'जिल्ला पूर्वाधार कार्यालयका प्रमुख रामबहादुर थापाका अनुसार १२० मिटर लामो नयाँ संरचनाले तीन हप्ताअघिदेखि विच्छेदित तीन वडाका ३२० घरधुरीलाई सेवा दिनेछ। “आगामी वर्षको वर्षाअघि पुल सञ्चालनमा आउने अपेक्षा गरेका छौँ,” थापाले भने।',
    '## नोभेम्बरमा काम सुरु हुने', 'कार्यालयका अनुसार निर्माण नोभेम्बर १० बाट सुरु हुनेछ र करिब ६० स्थानीयले रोजगारी पाउनेछन्। त्यतिन्जेल १२ किलोमिटर माथिको अस्थायी झोलुङ्गे पुल नै एकमात्र बाटो हुनेछ।',
    'स्थानीय बासिन्दा सीता चौधरीका अनुसार बाढीयता बालबालिका विद्यालय पुग्न दुई घण्टा हिँडिरहेका छन्, जबकि वडाध्यक्ष हरिप्रसाद जोशीले स्थानीयले वर्षौंदेखि स्थायी समाधान मागेको बताए।',
    'ठेकेदार हिमाल कन्स्ट्रक्सनले वर्षको अन्त्यसम्म जग निर्माणको ७० प्रतिशत काम सक्ने प्रतिबद्धता जनाएको कार्यालयले जनाएको छ।'].join('\n\n'),
  graphic_headline: 'कैलालीमा बाढीले बगाएको पुल बन्ने', graphic_description: '४५ मिलियन रुपैयाँको ठेक्कासँगै बाढीपछि विच्छेदित ३२० घरधुरी पुनः जोडिनेछन्।',
  social_caption: `बाढीले मोहना नदीको पुल बगाएको तीन हप्तापछि कैलालीमा पुनर्निर्माणका लागि ४५ मिलियन रुपैयाँको ठेक्का दिइएको छ। जिल्ला पूर्वाधार कार्यालयका अनुसार १२० मिटर लामो नयाँ पुलले तीन वडाका ३२० घरधुरीलाई फेरि जोड्नेछ। नोभेम्बर १० देखि करिब ६० स्थानीयलाई रोजगारी दिँदै निर्माण सुरु हुनेछ र आगामी वर्षको वर्षाअघि पुल खुला गर्ने कार्यालयको अपेक्षा छ। त्यतिन्जेल १२ किलोमिटर माथिको अस्थायी झोलुङ्गे पुल नै एकमात्र बाटो हो, जहाँ बालबालिका विद्यालय पुग्न दुई घण्टा हिँड्न बाध्य छन्।\n${URL_TOKEN}\n#कैलाली #नेपाल #पूर्वाधार #बाढी`,
  short_caption: 'कैलालीको बाढीले बगाएको मोहना पुल पुनर्निर्माणका लागि ४५ मिलियन रुपैयाँको ठेक्का; ३२० घरधुरी तीन हप्तादेखि विच्छेदित। #कैलाली',
  seo_title: 'कैलालीको मोहना पुल ४५ मिलियन रुपैयाँमा पुनर्निर्माण हुने', meta_description: 'बाढीले बगाएको कैलालीको मोहना नदीको पुल ४५ मिलियन रुपैयाँको ठेक्कामा पुनर्निर्माण हुने भएको छ; ३२० घरधुरी पुनः जोडिनेछन्।',
  keywords: ['कैलाली', 'मोहना नदी पुल', 'बाढी', 'पूर्वाधार', 'नेपाल'], hashtags: ['#कैलाली', '#नेपाल', '#पूर्वाधार'], alt_text: 'कैलालीको मोहना नदीको पुल पुनर्निर्माणबारे एभरेस्ट न्युजको ग्राफिक',
};
export const FACTS = [{ kind: 'number', value: 'Rs 45 million' }, { kind: 'number', value: '320 households' }, { kind: 'date', value: 'September 28' }, { kind: 'name', value: 'Ram Bahadur Thapa' }];
// the model's JSON reply. `over` lets a test damage one edition/field.
export function bundle(primary, over = {}) {
  const o = { source_assessment: { sufficient: true, gaps: [] }, facts: FACTS, quotes: [{ speaker: primary === 'en' ? 'Ram Bahadur Thapa' : 'रामबहादुर थापा', source_text: primary === 'en' ? EN_QUOTE : NE_QUOTE }], ne: { ...NE_ED }, en: { ...EN_ED } };
  for (const [k, v] of Object.entries(over)) { if (typeof v === 'object' && v && !Array.isArray(v) && o[k] && typeof o[k] === 'object') o[k] = { ...o[k], ...v }; else o[k] = v; }
  return o;
}
