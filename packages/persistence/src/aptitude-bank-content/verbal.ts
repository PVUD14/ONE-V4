/**
 * Verbal ability items (ENG-10): 5 skills, 12 items each.
 *
 * Why this exists: vocabulary, grammar, sentence completion, reading and idiom items are written
 * out one by one in original wording. The three reading passages were written for this pack and
 * describe no real place, organisation or person. Every item has one best answer and its wrong
 * options each show a named, common error.
 */
import type { AptitudeItem } from '../aptitude-bank.js';
import { authoringFor } from './skills.js';
import { buildItem, itemKey, type ItemSpec, type WrongOption } from './author.js';

interface Written {
  readonly difficulty: ItemSpec['difficulty'];
  readonly prompt: string;
  readonly answer: string;
  readonly wrong: readonly [WrongOption, WrongOption, WrongOption];
  readonly explanation: string;
  readonly step: string;
  readonly near: string;
  readonly check?: string;
}

function skillItems(skill: string, nudge: string, strategy: string, items: readonly Written[]): AptitudeItem[] {
  const authoring = authoringFor(skill);
  return items.map((item, index) => buildItem(authoring, {
    key: itemKey(skill, index + 1), difficulty: item.difficulty, prompt: item.prompt, answer: item.answer, wrong: item.wrong,
    explanation: item.explanation, hints: [nudge, strategy, item.step, item.near], ...(item.check ? { check: item.check } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------
const OPP = 'APT_V_VOCAB_OPPOSITE_CHOSEN';
const LOOK = 'APT_V_VOCAB_SOUND_ALIKE';
const syn = (word: string, answer: string, wrong: readonly [WrongOption, WrongOption, WrongOption], meaning: string, difficulty: ItemSpec['difficulty'] = 'FOUNDATION'): Written => ({
  difficulty, prompt: `Choose the word closest in meaning to ${word}.`, answer, wrong,
  explanation: `${word[0]}${word.slice(1).toLowerCase()} means ${meaning}; "${answer.toLowerCase()}" is closest.`,
  step: `"${word[0]}${word.slice(1).toLowerCase()}" means ${meaning}.`,
  near: `Two options may be tempting: one means the opposite, one only looks like ${word.toLowerCase()}. Rule them out.`,
});
const ant = (word: string, answer: string, wrong: readonly [WrongOption, WrongOption, WrongOption], meaning: string, difficulty: ItemSpec['difficulty'] = 'FOUNDATION'): Written => ({
  difficulty, prompt: `Choose the word opposite in meaning to ${word}.`, answer, wrong,
  explanation: `${word[0]}${word.slice(1).toLowerCase()} means ${meaning}; its opposite is "${answer.toLowerCase()}".`,
  step: `${word[0]}${word.slice(1).toLowerCase()} means ${meaning}.`,
  near: `Rule out ${wrong.filter((option) => option.code).map((option) => `"${option.text}"`).join(' and ')}: ${wrong.filter((option) => option.code).length > 1 ? 'one means the same as' : 'it means the same as'} ${word.toLowerCase()}${wrong.filter((option) => option.code).length > 1 ? ' and one only looks like it' : ''}. Which remaining option means the reverse?`,
});
const vocabulary = skillItems('apt-v-vocabulary', 'First decide whether the question wants the same meaning or the opposite.', 'Put the word in a simple sentence, then try each option in its place.', [
  syn('ABUNDANT', 'Plentiful', [{ text: 'Scarce', code: OPP }, { text: 'Abandoned', code: LOOK }, { text: 'Heavy' }], 'existing in large quantities'),
  syn('BRIEF', 'Short', [{ text: 'Lengthy', code: OPP }, { text: 'Brisk', code: LOOK }, { text: 'Simple' }], 'lasting only a little time'),
  syn('CANDID', 'Frank', [{ text: 'Secretive', code: OPP }, { text: 'Candied', code: LOOK }, { text: 'Careful' }], 'honest and direct', 'INTERMEDIATE'),
  syn('DILIGENT', 'Hardworking', [{ text: 'Lazy', code: OPP }, { text: 'Delicate', code: LOOK }, { text: 'Intelligent' }], 'showing steady, careful effort'),
  syn('OBSOLETE', 'Outdated', [{ text: 'Modern', code: OPP }, { text: 'Absolute', code: LOOK }, { text: 'Hidden' }], 'no longer in use', 'INTERMEDIATE'),
  syn('METICULOUS', 'Very careful', [{ text: 'Careless', code: OPP }, { text: 'Meteoric', code: LOOK }, { text: 'Quick' }], 'paying close attention to every detail', 'ADVANCED'),
  ant('EXPAND', 'Contract', [{ text: 'Enlarge', code: OPP }, { text: 'Expend', code: LOOK }, { text: 'Explain' }], 'to grow larger'),
  ant('ANCIENT', 'Modern', [{ text: 'Old', code: OPP }, { text: 'Distant' }, { text: 'Famous' }], 'very old'),
  ant('GENEROUS', 'Stingy', [{ text: 'Kind', code: OPP, why: 'Kind is close to generous in meaning; the question asks for the opposite.' }, { text: 'Genuine', code: LOOK }, { text: 'Rich' }], 'ready to give freely', 'INTERMEDIATE'),
  ant('TRANSPARENT', 'Opaque', [{ text: 'Clear', code: OPP }, { text: 'Transport', code: LOOK }, { text: 'Bright' }], 'letting light through, easy to see through', 'INTERMEDIATE'),
  ant('HUMBLE', 'Arrogant', [{ text: 'Modest', code: OPP }, { text: 'Humid', code: LOOK }, { text: 'Poor' }], 'modest about oneself'),
  ant('ACCEPT', 'Reject', [{ text: 'Receive', code: OPP }, { text: 'Except', code: LOOK }, { text: 'Deliver' }], 'to agree to take or receive'),
]);

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------
const AGR = 'APT_V_GRAM_AGREEMENT';
const TENSE = 'APT_V_GRAM_TENSE';
const PREP = 'APT_V_GRAM_PREPOSITION';
const ART = 'APT_V_GRAM_ARTICLE_BY_SPELLING';
const grammar = skillItems('apt-v-grammar', 'Only one sentence is fully correct; the others differ by one small point.', 'Check in turn: the subject and its verb, the tense, the articles, and the prepositions.', [
  { difficulty: 'FOUNDATION', prompt: 'Choose the grammatically correct sentence.', answer: 'The list of items is on the desk.',
    wrong: [{ text: 'The list of items are on the desk.', code: AGR, why: 'The verb agrees with "items", the nearest noun, instead of the subject "list".' }, { text: 'The list of items were on the desk.', code: AGR, why: 'The subject is the singular "list", not "items".' }, { text: 'The lists of item is on the desk.' }],
    explanation: 'The subject is "list" (singular), so the verb is "is"; "of items" only describes it.', step: 'The subject is "The list", not "items".', near: 'A singular subject takes "is".' },
  { difficulty: 'FOUNDATION', prompt: 'Choose the grammatically correct sentence.', answer: 'Each of the students has a notebook.',
    wrong: [{ text: 'Each of the students have a notebook.', code: AGR }, { text: 'Each of the student have a notebook.' }, { text: 'Each students has a notebook.' }],
    explanation: '"Each" is the singular subject, so it takes "has"; "of the students" needs the plural noun.', step: 'The subject is "Each", which is singular.', near: 'Look for "Each of the students" with a singular verb.' },
  { difficulty: 'ADVANCED', prompt: 'Choose the grammatically correct sentence.', answer: 'Neither the manager nor the clerks were present.',
    wrong: [{ text: 'Neither the manager nor the clerks was present.', code: AGR, why: 'With "neither … nor", the verb agrees with the nearer subject, "clerks", which is plural.' }, { text: 'Neither the manager or the clerks were present.' }, { text: 'Neither the manager nor the clerks is present.', code: AGR }],
    explanation: 'With "neither … nor" the verb agrees with the nearer subject; "clerks" is plural, so "were". The pair is "neither … nor", not "neither … or".',
    step: 'With "neither … nor", look at the subject closest to the verb.', near: '"Clerks" is plural; which sentence also keeps "nor"?',
    check: 'Uses the proximity rule for "neither … nor"; confirm this is the rule taught.' },
  { difficulty: 'INTERMEDIATE', prompt: 'Choose the grammatically correct sentence.', answer: 'She has lived in Pune since 2019.',
    wrong: [{ text: 'She is living in Pune since 2019.', code: TENSE }, { text: 'She lives in Pune since 2019.', code: TENSE }, { text: 'She has lived in Pune from 2019.', code: PREP }],
    explanation: 'An action continuing from a point in the past to now takes the present perfect ("has lived") with "since" and a starting point.', step: 'The action started in 2019 and continues now.', near: 'That needs "has lived" with "since".' },
  { difficulty: 'INTERMEDIATE', prompt: 'Choose the grammatically correct sentence.', answer: 'When I reached the station, the train had already left.',
    wrong: [{ text: 'When I reached the station, the train has already left.', code: TENSE }, { text: 'When I reached the station, the train already leaves.', code: TENSE }, { text: 'When I had reached the station, the train left already.' }],
    explanation: 'The train left before I reached the station, so the earlier past action takes the past perfect: "had already left".', step: 'Which happened first: reaching the station or the train leaving?', near: 'The earlier of two past actions takes "had" + past participle.' },
  { difficulty: 'FOUNDATION', prompt: 'Choose the grammatically correct sentence.', answer: 'He is good at mathematics.',
    wrong: [{ text: 'He is good in mathematics.', code: PREP }, { text: 'He is good on mathematics.', code: PREP }, { text: 'He are good at mathematics.' }],
    explanation: 'The fixed expression is "good at" a subject or activity.', step: 'The verb "is" agrees with "He"; the question is the preposition.', near: 'Which preposition follows "good" for a skill?',
    check: '"Good in" is heard in Indian English; confirm "good at" is the expected standard answer.' },
  { difficulty: 'INTERMEDIATE', prompt: 'Choose the grammatically correct sentence.', answer: 'I prefer tea to coffee.',
    wrong: [{ text: 'I prefer tea than coffee.', code: PREP }, { text: 'I prefer tea over than coffee.' }, { text: 'I am prefer tea to coffee.' }],
    explanation: '"Prefer" takes "to" for the thing not chosen: prefer A to B.', step: '"Prefer" compares two things.', near: '"Prefer" is followed by "to", not "than".' },
  { difficulty: 'FOUNDATION', prompt: 'Choose the grammatically correct sentence.', answer: 'She is an honest officer.',
    wrong: [{ text: 'She is a honest officer.', code: ART }, { text: 'She is honest officer.' }, { text: 'She is an honestly officer.' }],
    explanation: '"Honest" begins with a vowel sound (the h is silent), so it takes "an".', step: 'Say "honest" aloud: what is the first sound?', near: 'A vowel sound takes "an".' },
  { difficulty: 'INTERMEDIATE', prompt: 'Choose the grammatically correct sentence.', answer: 'It was a university event.',
    wrong: [{ text: 'It was an university event.', code: ART }, { text: 'It was university event.' }, { text: 'It was a universities event.' }],
    explanation: '"University" begins with a "yoo" consonant sound, so it takes "a", even though it is spelt with a vowel.', step: 'Say "university" aloud: what is the first sound?', near: 'A consonant sound takes "a", whatever the first letter.' },
  { difficulty: 'INTERMEDIATE', prompt: 'Choose the grammatically correct sentence.', answer: 'If it rains tomorrow, we will stay indoors.',
    wrong: [{ text: 'If it will rain tomorrow, we will stay indoors.', code: TENSE }, { text: 'If it rained tomorrow, we will stay indoors.', code: TENSE }, { text: 'If it rains tomorrow, we stayed indoors.' }],
    explanation: 'For a real future condition, the "if" clause takes the present tense and the main clause takes "will".', step: 'This is a real possibility about the future.', near: '"If" + present tense, then "will" + verb.' },
  { difficulty: 'FOUNDATION', prompt: 'Choose the grammatically correct sentence.', answer: 'One of my friends is a pilot.',
    wrong: [{ text: 'One of my friends are a pilot.', code: AGR }, { text: 'One of my friend is a pilot.' }, { text: 'One of my friends are pilots.', code: AGR }],
    explanation: 'The subject is "One" (singular), so the verb is "is"; "of my friends" needs the plural noun.', step: 'The subject is "One".', near: 'A singular subject takes "is", and "one of" takes a plural noun after it.' },
  { difficulty: 'ADVANCED', prompt: 'Choose the grammatically correct sentence.', answer: 'He has been waiting for two hours.',
    wrong: [{ text: 'He is waiting since two hours.', code: TENSE }, { text: 'He has been waiting since two hours.', code: PREP }, { text: 'He waits for two hours.' }],
    explanation: 'An action continuing up to now takes the present perfect continuous; a length of time takes "for", a starting point takes "since".', step: '"Two hours" is a length of time, not a starting point.', near: 'Length of time → "for"; continuing action → "has been waiting".' },
]);

// ---------------------------------------------------------------------------
// Sentence completion
// ---------------------------------------------------------------------------
const CLUE = 'APT_V_FILL_CLUE_MISSED';
const CONF = 'APT_V_FILL_WORD_CONFUSION';
const COLL = 'APT_V_FILL_COLLOCATION';
const completion = skillItems('apt-v-sentence-completion', 'Find the word in the sentence that tells you what the blank must mean.', 'Decide whether the blank continues the idea or contrasts with it, then check the word form fits the grammar.', [
  { difficulty: 'FOUNDATION', prompt: 'Although the task was difficult, she remained ____.', answer: 'determined',
    wrong: [{ text: 'discouraged', code: CLUE }, { text: 'difficult' }, { text: 'absent' }],
    explanation: '"Although" signals a contrast with "difficult": she stayed determined.', step: '"Although" sets up a contrast.', near: 'The blank must be the opposite of giving up.' },
  { difficulty: 'INTERMEDIATE', prompt: 'The medicine had an immediate ____ on the fever.', answer: 'effect',
    wrong: [{ text: 'affect', code: CONF }, { text: 'result', code: COLL }, { text: 'effort' }],
    explanation: '"Effect" is the noun; "have an effect on" is the fixed expression. "Affect" is usually a verb.', step: 'After "an immediate", the blank must be a noun.', near: 'Which noun goes in "have an ___ on"?' },
  { difficulty: 'FOUNDATION', prompt: 'He was so ____ that he gave away most of his savings to charity.', answer: 'generous',
    wrong: [{ text: 'greedy', code: CLUE }, { text: 'grateful', code: CONF }, { text: 'jealous' }],
    explanation: '"So … that he gave away most of his savings" shows the quality: generous.', step: '"So ____ that he gave away…" — the blank causes the giving.', near: 'Which quality makes someone give money away?' },
  { difficulty: 'FOUNDATION', prompt: 'The committee will ____ the proposal carefully before voting.', answer: 'consider',
    wrong: [{ text: 'considerate', code: CONF }, { text: 'conspire' }, { text: 'conserve' }],
    explanation: 'After "will", a verb is needed: "consider" means think about. "Considerate" is an adjective.', step: 'After "will", the blank is a verb.', near: 'Which verb means "think carefully about"?' },
  { difficulty: 'FOUNDATION', prompt: 'The weather was pleasant, ____ we decided to walk.', answer: 'so',
    wrong: [{ text: 'but', code: CLUE }, { text: 'although', code: CLUE }, { text: 'because' }],
    explanation: 'Pleasant weather is the reason for walking, so the linking word shows a result: "so".', step: 'Is walking a result of the pleasant weather, or a contrast?', near: 'Pick the word that introduces a result.' },
  { difficulty: 'INTERMEDIATE', prompt: 'She was tired; ____, she finished the report before leaving.', answer: 'nevertheless',
    wrong: [{ text: 'therefore', code: CLUE }, { text: 'moreover', code: CLUE }, { text: 'because' }],
    explanation: 'Finishing the report despite being tired is a contrast: "nevertheless".', step: 'Being tired would make finishing less likely.', near: 'Pick the word that means "in spite of that".' },
  { difficulty: 'INTERMEDIATE', prompt: 'The new rule is ____ to all employees, without exception.', answer: 'applicable',
    wrong: [{ text: 'applied', code: CONF }, { text: 'appliance', code: CONF }, { text: 'apply' }],
    explanation: '"Is ___ to" needs an adjective meaning "relevant to": applicable.', step: 'After "is", with "to" following, the blank is an adjective.', near: 'Which form of "apply" is an adjective meaning "relevant"?' },
  { difficulty: 'FOUNDATION', prompt: 'Despite heavy rain, the match was ____.', answer: 'completed',
    wrong: [{ text: 'cancelled', code: CLUE }, { text: 'postponed', code: CLUE }, { text: 'raining' }],
    explanation: '"Despite" signals that the outcome went against what the rain would suggest: the match was completed.', step: '"Despite" signals something unexpected.', near: 'Heavy rain would suggest cancellation; the blank is the opposite.' },
  { difficulty: 'FOUNDATION', prompt: 'The lecture was so ____ that several students fell asleep.', answer: 'dull',
    wrong: [{ text: 'exciting', code: CLUE }, { text: 'short' }, { text: 'useful' }],
    explanation: '"So … that several students fell asleep" shows the lecture was dull.', step: 'The blank caused the students to fall asleep.', near: 'Which quality makes listeners fall asleep?' },
  { difficulty: 'FOUNDATION', prompt: 'She is interested ____ learning French.', answer: 'in',
    wrong: [{ text: 'on', code: COLL }, { text: 'at', code: COLL }, { text: 'for' }],
    explanation: 'The fixed pairing is "interested in".', step: '"Interested" always takes the same preposition.', near: 'Which preposition follows "interested"?' },
  { difficulty: 'ADVANCED', prompt: 'The results were ____ with our predictions: nothing unexpected happened.', answer: 'consistent',
    wrong: [{ text: 'inconsistent', code: CLUE }, { text: 'constant', code: CONF }, { text: 'content' }],
    explanation: '"Nothing unexpected happened" means the results matched: consistent with the predictions.', step: 'The part after the colon explains the blank.', near: 'Which word means "in agreement with"?' },
  { difficulty: 'INTERMEDIATE', prompt: 'He did not study; ____, he failed the test.', answer: 'consequently',
    wrong: [{ text: 'however', code: CLUE }, { text: 'although' }, { text: 'besides' }],
    explanation: 'Failing is the result of not studying: "consequently".', step: 'Is failing a result of not studying, or a contrast?', near: 'Pick the word that introduces a result.' },
]);

// ---------------------------------------------------------------------------
// Reading comprehension
// ---------------------------------------------------------------------------
const OUT = 'APT_V_RC_OUTSIDE_KNOWLEDGE';
const OVER = 'APT_V_RC_OVERSTATED';
const DETAIL = 'APT_V_RC_DETAIL_AS_MAIN_IDEA';
const CHANGED = 'APT_V_RC_CHANGED_DETAIL';
const LITERAL = 'APT_V_RC_LITERAL_SENSE';

const P1 = 'Many small towns once had a reading room where newspapers were shared by everyone. As mobile phones became common, fewer people visited these rooms, and some closed. In a few towns, however, volunteers turned the rooms into study spaces with quiet desks and evening hours. Students preparing for examinations began to use them, and older residents returned to read and talk. The rooms that survived were the ones that changed what they offered rather than the ones that simply waited for readers to come back.';
const P2 = 'Drip irrigation delivers water directly to the roots of plants through narrow tubes. Because less water evaporates or runs off, farmers who use it often need less water than those who flood their fields. The equipment, however, costs money to buy and must be maintained, and the tubes can clog if the water carries a lot of sediment. For these reasons, drip irrigation suits some farms better than others, and farmers weigh the savings in water against the costs of the system.';
const P3 = 'When a town council proposed moving the main bus stop from the market to the new hospital, shopkeepers objected that they would lose customers. The council held two public meetings. At the second meeting it offered a compromise: buses would stop at both places, adding one minute to each journey. Most shopkeepers accepted the plan, although a few still argued that the market stop should come first on the route.';
const passage = (text: string, question: string): string => `Read the passage and answer the question.\n\n${text}\n\n${question}`;
const rc = 'Every answer must be supported by the passage itself.';
const rcStrategy = 'Find the sentence in the passage that decides the question; reject options that go further than it, change it, or rely on what you already know.';
const reading = skillItems('apt-v-reading-comprehension', rc, rcStrategy, [
  { difficulty: 'INTERMEDIATE', prompt: passage(P1, 'Which statement best expresses the main idea of the passage?'), answer: 'Reading rooms that adapted to new needs were more likely to survive.',
    wrong: [{ text: 'Mobile phones have ended the habit of reading newspapers.', code: OVER }, { text: 'Students preparing for examinations need quiet places to study.', code: DETAIL }, { text: 'Every town should build a public library.', code: OUT }],
    explanation: 'The last sentence sums up the passage: the rooms that survived were the ones that changed what they offered.', step: 'The final sentence draws the conclusion of the whole passage.', near: 'Pick the option that restates that conclusion without adding to it.' },
  { difficulty: 'FOUNDATION', prompt: passage(P1, 'According to the passage, who began using the converted rooms?'), answer: 'Students preparing for examinations, and older residents',
    wrong: [{ text: 'Only students', code: OVER }, { text: 'Newspaper publishers', code: CHANGED }, { text: 'People who had given up their mobile phones', code: OUT }],
    explanation: 'The passage says students preparing for examinations began to use them, and older residents returned.', step: 'Look at the sentence that begins "Students preparing for examinations…".', near: 'That sentence names two groups.' },
  { difficulty: 'INTERMEDIATE', prompt: passage(P1, 'What can be inferred about reading rooms that did not change?'), answer: 'Many of them lost visitors or closed.',
    wrong: [{ text: 'They were all closed by the government.', code: OUT }, { text: 'They became more popular than before.', code: CHANGED }, { text: 'They all turned into study spaces.', code: OVER }],
    explanation: 'The passage says fewer people visited, some closed, and the survivors were the ones that changed — so those that did not change mostly lost visitors or closed.', step: 'The passage contrasts rooms that changed with rooms that "simply waited".', near: 'What does the passage say happened to rooms in general as phones spread?' },
  { difficulty: 'FOUNDATION', prompt: passage(P1, 'In the passage, the word "survived" most nearly means:'), answer: 'continued to operate',
    wrong: [{ text: 'were rescued from danger', code: LITERAL }, { text: 'were rebuilt' }, { text: 'became famous' }],
    explanation: 'Rooms that "survived" are the ones that kept running rather than closing.', step: 'Reread the last sentence with each option in place of "survived".', near: 'The contrast is with rooms that closed.' },
  { difficulty: 'INTERMEDIATE', prompt: passage(P2, 'Which statement best expresses the main idea of the passage?'), answer: 'Drip irrigation saves water but has costs, so it suits some farms more than others.',
    wrong: [{ text: 'Drip irrigation is the best method for every farm.', code: OVER }, { text: 'Tubes can clog if the water carries sediment.', code: DETAIL }, { text: 'Flooding fields should be banned.', code: OUT }],
    explanation: 'The passage weighs the water saved against the equipment\'s costs and concludes that it suits some farms better than others.', step: 'The passage gives an advantage, then drawbacks, then a conclusion.', near: 'Pick the option that keeps both sides and the conclusion.' },
  { difficulty: 'FOUNDATION', prompt: passage(P2, 'Why do farmers who use drip irrigation often need less water?'), answer: 'Less water is lost to evaporation and run-off.',
    wrong: [{ text: 'The tubes store water for the dry season.', code: CHANGED }, { text: 'Plants grown this way need less water to grow.', code: OUT }, { text: 'Drip systems never need maintenance.', code: OVER }],
    explanation: 'The second sentence gives the reason: less water evaporates or runs off.', step: 'Look for the word "because" in the passage.', near: 'The reason is about where the water goes, not what the plants need.' },
  { difficulty: 'ADVANCED', prompt: passage(P2, 'According to the passage, which farm would find drip irrigation hardest to use?'), answer: 'A farm whose water carries a lot of sediment',
    wrong: [{ text: 'A farm that grows rice', code: OUT }, { text: 'A farm that has very little water' }, { text: 'Any farm that uses tubes of any kind', code: OVER }],
    explanation: 'The passage names one practical problem: tubes clog when the water carries a lot of sediment.', step: 'Which drawback in the passage depends on the farm\'s conditions?', near: 'The clogging problem depends on the water.' },
  { difficulty: 'INTERMEDIATE', prompt: passage(P2, 'In the passage, the word "weigh" most nearly means:'), answer: 'compare',
    wrong: [{ text: 'measure the heaviness of', code: LITERAL }, { text: 'lift' }, { text: 'ignore' }],
    explanation: 'Farmers "weigh the savings … against the costs": they compare them.', step: 'Reread "weigh the savings in water against the costs".', near: 'Which option fits "___ the savings against the costs"?' },
  { difficulty: 'INTERMEDIATE', prompt: passage(P3, 'Which statement best expresses the main idea of the passage?'), answer: 'A council reached a compromise after hearing objections to moving a bus stop.',
    wrong: [{ text: 'Shopkeepers always oppose change.', code: OVER }, { text: 'Each bus journey became one minute longer.', code: DETAIL }, { text: 'Hospitals need bus stops more than markets do.', code: OUT }],
    explanation: 'The passage tells how an objection led to meetings and a compromise that most accepted.', step: 'Follow the sequence: proposal, objection, meetings, compromise.', near: 'Pick the option that covers the whole sequence.' },
  { difficulty: 'FOUNDATION', prompt: passage(P3, 'What did the compromise include?'), answer: 'Buses stopping at both the market and the hospital',
    wrong: [{ text: 'Moving the stop to the hospital only', code: CHANGED }, { text: 'Removing a minute from each journey', code: CHANGED }, { text: 'Holding a third public meeting' }],
    explanation: 'The compromise was that buses would stop at both places, adding one minute to each journey.', step: 'Find the sentence with the word "compromise".', near: 'Read what comes after the colon.' },
  { difficulty: 'INTERMEDIATE', prompt: passage(P3, 'What can be inferred about the few shopkeepers who still argued?'), answer: 'They wanted the market stop to be served before the hospital stop.',
    wrong: [{ text: 'They rejected the plan completely.', code: OVER }, { text: 'They had shops near the hospital.', code: OUT }, { text: 'They wanted the extra minute removed.', code: CHANGED }],
    explanation: 'The last sentence says they argued that the market stop should come first on the route.', step: 'Look at the last sentence.', near: 'What did they want about the order of the stops?' },
  { difficulty: 'ADVANCED', prompt: passage(P3, 'The passage is best described as:'), answer: 'A neutral account of how a disagreement was settled',
    wrong: [{ text: 'A complaint against the council', code: OUT }, { text: 'An advertisement for the market' }, { text: 'A report on the new hospital\'s services', code: DETAIL }],
    explanation: 'The passage reports what happened without taking a side.', step: 'Does the writer take a side or praise anything?', near: 'Pick the description that matches a plain report of events.' },
]);

// ---------------------------------------------------------------------------
// Idioms
// ---------------------------------------------------------------------------
const LIT = 'APT_V_IDIOM_LITERAL';
const OPPOSITE = 'APT_V_IDIOM_OPPOSITE_SENSE';
const idiom = (phrase: string, answer: string, wrong: readonly [WrongOption, WrongOption, WrongOption], example: string, difficulty: ItemSpec['difficulty'] = 'FOUNDATION'): Written => ({
  difficulty, prompt: `What does the idiom "${phrase}" mean?`, answer, wrong,
  explanation: `"${phrase[0]!.toUpperCase()}${phrase.slice(1)}" means ${answer.toLowerCase()}. For example: "${example}"`,
  step: `Picture it in a sentence: "${example}"`,
  near: `Rule out "${wrong.find((option) => option.code === LIT)?.text ?? wrong[0].text}", the literal picture. Which remaining meaning fits the sentence?`,
});
const idioms = skillItems('apt-v-idioms', 'An idiom does not mean what its words say one by one.', 'Think of a sentence where you have heard the idiom, and choose the meaning that fits that sentence.', [
  idiom('a piece of cake', 'Something very easy', [{ text: 'A small dessert', code: LIT }, { text: 'A share of the profit' }, { text: 'Something very difficult', code: OPPOSITE }], 'The first question was a piece of cake; I answered it in a minute.'),
  idiom('break the ice', 'To ease the awkwardness when people first meet', [{ text: 'To damage something frozen', code: LIT }, { text: 'To end a friendship' }, { text: 'To start a quarrel', code: OPPOSITE }], 'She told a joke to break the ice at the start of the meeting.'),
  idiom('once in a blue moon', 'Very rarely', [{ text: 'On a clear night', code: LIT }, { text: 'Very often', code: OPPOSITE }, { text: 'During a festival' }], 'We meet once in a blue moon now that we live in different cities.'),
  idiom('hit the nail on the head', 'To describe exactly what is causing a situation', [{ text: 'To hurt oneself while working', code: LIT }, { text: 'To act violently' }, { text: 'To miss the main point', code: OPPOSITE }], 'You hit the nail on the head when you said the delay was caused by the missing form.', 'INTERMEDIATE'),
  idiom('burn the midnight oil', 'To work or study late into the night', [{ text: 'To waste fuel', code: LIT }, { text: 'To be very angry' }, { text: 'To go to bed early', code: OPPOSITE }], 'She burnt the midnight oil before her final examination.'),
  idiom('let the cat out of the bag', 'To reveal a secret by mistake', [{ text: 'To free a trapped animal', code: LIT }, { text: 'To cause confusion' }, { text: 'To keep a secret carefully', code: OPPOSITE }], 'He let the cat out of the bag about the surprise party.'),
  idiom('cost an arm and a leg', 'To be very expensive', [{ text: 'To cause a serious injury', code: LIT }, { text: 'To be very cheap', code: OPPOSITE }, { text: 'To take a long time' }], 'That phone cost an arm and a leg.'),
  idiom('under the weather', 'Slightly unwell', [{ text: 'Outdoors in the rain', code: LIT }, { text: 'Worried about the future' }, { text: 'In very good health', code: OPPOSITE }], 'I stayed home because I was feeling under the weather.', 'INTERMEDIATE'),
  idiom('beat around the bush', 'To avoid saying something directly', [{ text: 'To search a garden carefully', code: LIT }, { text: 'To speak plainly and directly', code: OPPOSITE }, { text: 'To punish someone' }], 'Stop beating around the bush and tell me what happened.', 'INTERMEDIATE'),
  idiom('spill the beans', 'To reveal secret information', [{ text: 'To waste food', code: LIT }, { text: 'To cook carelessly' }, { text: 'To lose money' }], 'Someone spilled the beans about the new project before it was announced.'),
  idiom('get cold feet', 'To become nervous and hesitate before something planned', [{ text: 'To feel physically cold', code: LIT }, { text: 'To feel confident and eager', code: OPPOSITE }, { text: 'To lose interest in sport' }], 'He got cold feet just before his speech.', 'INTERMEDIATE'),
  idiom('a blessing in disguise', 'Something that seems bad at first but turns out well', [{ text: 'A person wearing a costume', code: LIT }, { text: 'A gift received secretly' }, { text: 'Something that seems good but turns out badly', code: OPPOSITE }], 'Missing the bus was a blessing in disguise: I met an old friend while waiting.', 'ADVANCED'),
]);

export const VERBAL_ITEMS: readonly AptitudeItem[] = [...vocabulary, ...grammar, ...completion, ...reading, ...idioms];
