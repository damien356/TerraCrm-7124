/* ---------------------------------------------------------------------------
 * The after-job care emails, as written in the care series spec
 * (Attachments/after_job_care_series). Section 18.37.
 *
 * Generated once from the spec by terra-scratch-tests/care/gen-templates.py.
 * Damien edits them on the Care page, and an edit is stored in care_templates,
 * so this file is only the starting copy. The sign-off and the unsubscribe line
 * are added when the email is put together (lib/care-render.ts).
 *
 * In the body: {{first_name}} fills in, {if Wool} ... {/if} style blocks show
 * only to the right people, and {video} is where the T5 thumbnail goes.
 *
 * No imports on purpose.
 * ------------------------------------------------------------------------- */

export interface CareTemplate {
  code: string;
  title: string;
  /** Who it is for, as the spec says it. */
  audience: string;
  subject: string;
  body: string;
}

export const CARE_TEMPLATES: CareTemplate[] = [
  {
    "code": "A1",
    "title": "Don't stay silent",
    "audience": "all flooring",
    "subject": "Please don't do the haircut thing",
    "body": "Hey {{first_name}},\n\nI know the subject line may not make sense by itself, but let me explain.\n\nI'm sure you, or someone you know, has had a haircut they hated but didn't say anything when the barber held the mirror up behind their head.\n\nWhat I don't want is for my clients to do that to me. If you've been left with a bitter taste in your mouth after we left, or even months later, please, please don't keep silent. We can't fix what we don't know is wrong.\n\nEven the silliest thing (maybe it's nothing), just send us an email or a photo. We are here for you, not the other way around, and it's no bother whatsoever.\n\nI had a lovely client tell me she wasn't happy with her floor 12 months after we installed it, and she was so apologetic, as if contacting me was a bother. I try to learn from every situation, which is why I'm writing this email, so you know I've got your back and I'm 100% here for you all the way."
  },
  {
    "code": "C1",
    "title": "Vacuum your carpet regularly",
    "audience": "carpet",
    "subject": "The secret to carpet that lasts",
    "body": "Hey {{first_name}},\n\nI want your carpet to look its best for as long as possible, and without maintenance it won't stand the test of time.\n\nI don't want you to rush off and buy a $700 Dyson. A $100 Kmart vacuum will do the trick, as long as it's at least 2000 watts so it has decent suction.\n\nThe second important thing is the head of your vacuum. The best one for your carpet is a spin head (turbo head).\n\nYou can pick up a spin head at an affordable price from Godfreys (click [HERE](https://www.godfreys.com.au/clean-up-turbo-floor-brush)). Prices start from about $50 and believe me, you'll thank me later. It flicks the dirt out of the carpet into the vacuum and acts like a brush, helping lift the fibres.\n\nI recommend vacuuming at least once a week. The manufacturers recommend daily, but that's easy for them to say. They're not the ones doing it!\n\nAnd if you ever get a stain, just tell me what it is and I'll reply with what to grab from the supermarket to fix it."
  },
  {
    "code": "C1-W",
    "title": "Vacuuming your wool or loop carpet",
    "audience": "carpet tagged Wool, Wool blend or Loop pile",
    "subject": "The one vacuum setting your carpet needs",
    "body": "Hey {{first_name}},\n\nI want your carpet to look its best for as long as possible, and the way you vacuum it makes a huge difference.\n\nYou don't need a $700 Dyson. A $100 Kmart vacuum will do the trick, as long as it's at least 2000 watts so it has decent suction.\n\nHere's the important bit for your carpet: **don't use a spin head (turbo head or beater bar) on it. If your vacuum has one, turn the spin off, or use the plain suction head.**\n\n{if Wool} Wool is a natural fibre, and the spinning brush roughs up the ends of the fibres. It makes the carpet pill and fluff up far faster than it's designed to, and it will wear out years early. Suction alone is all wool needs. {/if}\n{if Loop pile} On a loop pile carpet, the spinning brush can catch and pull the loops, and once a loop is pulled it can run like a ladder in stockings. Suction alone is the safe way. {/if}\n\nA few more tips:\n- Vacuum at least once a week, going slowly so the suction has time to work, especially in walkways.\n- **Fluff in the vacuum is normal** for the first few months. {if Wool}Wool sheds more than synthetic carpet while the loose fibres from manufacturing work their way out.{/if} It settles down and doesn't mean the carpet is wearing out.\n- If a loop or tuft ever sticks up, never pull it. Snip it level with sharp scissors.\n\nIf you get a stain, tell me what it is before you treat it and I'll reply with what's safe to use on your carpet."
  },
  {
    "code": "C6",
    "title": "Living with a wool carpet",
    "audience": "wool and wool blend only",
    "subject": "A few things only wool carpet owners need to know",
    "body": "Hi {{first_name}},\n\nWool is a beautiful, natural carpet. It's warm, it bounces back, and it naturally resists fire and soiling. Like anything natural, it just needs a slightly different kind of care.\n\n- **Vacuum with suction only.** No spin head or beater bar. It makes wool pill and fluff.\n- **Never use bleach, ammonia, or \"oxy\" stain removers** on wool. They strip the colour and damage the fibre. A small amount of wool wash (like Softly or Woolmix) in cool water, blotted on and blotted off, is the safest DIY spot treatment.\n- **Cool water only.** Hot water can shrink wool fibres and set some stains.\n- **Professional cleaning:** make sure the cleaner is experienced with wool and uses wool-safe products (look for the Woolsafe-approved logo). Wool should be cleaned at lower temperatures and dried quickly.\n- **Moths and carpet beetles:** wool can attract them, mainly in dark, undisturbed spots like under beds, behind couches and in wardrobes. Vacuuming those spots every few weeks is the best prevention. If you see small bare patches or tiny larvae, let me know.\n- **Sun:** wool can fade in strong direct sun. Close the blinds on the hottest part of the day.\n\nLook after it like this and a good wool carpet will outlast almost anything."
  },
  {
    "code": "C2",
    "title": "Top 5 carpet stain removal tips",
    "audience": "carpet",
    "subject": "My top 5 carpet stain tips (save this one)",
    "body": "Heya {{first_name}}, here are my top 5 carpet stain removal tips.\n\n{if Wool or Wool blend}\n> **Important: your carpet is wool.** Skip the OxiClean and laundry-detergent steps below completely, and never use bleach. They can strip the colour out of wool. Use cool water only, and swap the dish soap or detergent for a small amount of wool wash. If in doubt, send me a photo first.\n{/if}\n\nLet's face it, it's bound to happen to all of us at some point. In an instant, a mishap occurs with a sippy cup of cordial, a drop of blood, or your beloved pet who couldn't hold it any longer. So take a deep breath, read on, and that stain will vanish before too long!\n\n**Cordial: because kids will be kids**\n- Always gently blot the stain with a dry white towel first. Never rub. It makes the stain harder to remove and can soak through to the underlay.\n- Mix 1/4 cup of white vinegar and 1 tablespoon of Dawn dish soap in a spray bottle and top up with water. Spray the area well, leave for 5 to 10 minutes, then blot with a clean dry towel until it's gone.\n- For stubborn stains, try Britex carpet stain remover from Woolworths as directed, then repeat the vinegar spray.\n\n**Pet stains: from those beloved naughty cute things**\n- Pick up any mess with gloves. If it's wet, blot (don't rub) until the carpet is almost dry to the touch.\n- If it's already dried, dampen it first, then use a pet stain remover like Britex. To neutralise the odour, mix 1/4 cup of white vinegar with about a litre of warm water, spray, leave a few minutes, then blot dry.\n- Another option: a litre of water with a stain-fighting laundry detergent in a spray bottle. Spray, leave a few minutes, blot, rinse with warm water and repeat if needed.\n\n**Coffee: because we can't live without it**\n- Blot with a dry white towel, swapping cloths as they soak up so you don't spread it.\n- Try the vinegar, water and gentle non-bleach detergent spray, then rinse and repeat.\n- Supermarket coffee stain cleaners work too. Always patch test first and wear gloves.\n\n**Blood: from those paper cuts!**\n- Always use cold water, never warm or hot. Heat sets blood into the fibres.\n- Mix 2 teaspoons of Dawn dish soap with cold water in a spray bottle, soak the stain, blot with a paper towel or white cloth, rinse with cold water and repeat.\n- OxiClean (bleach-free) works well too. Mix it as best you can in cold water, apply, blot, rinse and repeat. It may take a few goes.\n\n**Ink: who uses pens these days anyway?**\n- Dab (don't rub!) with a clean white cloth dampened with isopropyl alcohol. Leave a few minutes, then blot or wet-vac up the moisture.\n- Repeat if needed, then rinse with water and blot dry.\n\nWhatever you use, always test on a hidden spot first, like inside a wardrobe.\n\nIf all else fails, give me a call and I'll guide you further!"
  },
  {
    "code": "C3",
    "title": "12-month carpet clean and warranty",
    "audience": "carpet, fixed 12-month date, then yearly",
    "subject": "Your carpet's first birthday: time for a proper clean",
    "body": "Hey {{first_name}},\n\nIt's been 12 months since we installed your carpet, so here's the reminder I promised.\n\nImagine a shirt lying on the floor for 12 months that you vacuum every few days. After a year, do you think it deserves a wash? Your carpet is the same.\n\nCarpet manufacturers require carpet to be professionally cleaned every 12 months (18 months at the very most) to keep the warranty valid, and believe me, if there's ever a problem, they ask for the receipts. So please keep yours somewhere safe.\n\nOne important thing: a hire machine from Bunnings or the supermarket doesn't count. It needs to be a proper professional carpet cleaner with a truck-mounted or commercial machine, and you'll want a receipt that shows the date and address.\n\nDon't worry about moving beds or heavy furniture. Under those spots doesn't get walked on, so a vacuum is all they need. Cleaners can just go around them.\n\n{if Wool or Wool blend} As your carpet is wool, make sure the cleaner is experienced with wool and uses wool-safe products (look for the Woolsafe-approved logo). {/if}\n\nA properly maintained carpet can last twice as long, so this one is well worth it.\n\nI'll send you this reminder again next year so you never miss it."
  },
  {
    "code": "C4",
    "title": "Carpet cleaning for rental homes",
    "audience": "carpet, landlords only",
    "subject": "A quick word about your rental carpet",
    "body": "Hi {{first_name}},\n\nFirstly, congratulations on your new carpet!\n\nYour carpet, like many things you buy, needs a little TLC (tender, loving care), not much, but it still needs it. You may mention this to your tenants, but whether they do it is another story.\n\nImagine owning a car rental company. You rent cars to mums and dads, even on a long lease, and you tell them they need to service the car every 6 months. If the car develops a fault, do you think the manufacturer will be asking the renters for proof of servicing?\n\nCarpet is the same. At the end of the day, you're responsible for the maintenance. You can build it into the rent (around $5 a week covers a 3 bedroom home with a hallway and lounge) or clean it yourself and back-charge, but either way it's on you.\n\nOver the last 25 years I've replaced so much rental carpet from a lack of maintenance it isn't funny, and a lot of it was under 5 years old. That's sad, because properly maintained you can double the life of your carpet, and prices aren't going down.\n\nCarpet manufacturers require carpets to be professionally cleaned every 12 months (18 months at most), and they will ask for receipts if anything goes wrong.\n\nNot to worry, I'll send you an email when it's due so you don't miss it."
  },
  {
    "code": "T1",
    "title": "Congratulations on your timber floor",
    "audience": "engineered timber",
    "subject": "Congratulations on your new timber floor!",
    "body": "Hi {{first_name}},\n\nCongratulations on your natural timber floor!\n\nLike anything natural, it takes a little more TLC (tender loving care) than a fake floor, but we can't really compare the two anyway.\n\nFor the first 12 months your timber floor will darken, so it's important NOT to put mats or rugs down. Mats or rugs with rubber backing can also react with the floor coating, so we don't recommend those at all.\n\nAny low-lying furniture touching the floor, I recommend moving once a month for the first 12 months only (I'll send you a reminder).\n\nNow, having said all that, if you don't follow any of the above, it won't damage or ruin your floor. If you move your furniture, the lighter spots that haven't seen UV light will eventually darken to match the rest.\n\nA few things that really help:\n- **Felt pads** from Bunnings under all furniture legs, so you can push furniture around without lifting it.\n- **Moving the fridge?** Buy one sheet of 1830 x 915 x 3mm MDF from Bunnings (click [HERE](https://www.bunnings.com.au/customwood-mdf-1830-x-915-x-3mm-standard-mdf-panel_p0590074)) and cut it in half to make two pieces about 90cm x 90cm. Slide the fridge onto one, then onto the other, and leapfrog them. Grit and timber don't go well together, so make sure the floor is clean before putting the MDF down.\n- **Office chairs:** swap plastic wheels for rubber/silicone ones. Rubber rolls over grit; plastic drags it and can scratch your floor.\n\nScuff marks and light scratches can be fixed easily in a few seconds. Deep scratches or dents can't be patched, but the board can be replaced. Just let us know.\n\nI hope you enjoy your new floor as much as we enjoyed installing it. Any question, big or small, just email, SMS or call.\n\nTalk soon {{first_name}}."
  },
  {
    "code": "T2",
    "title": "Monthly furniture shuffle + cleaning",
    "audience": "engineered timber",
    "subject": "It's that time of the month",
    "body": "Hi {{first_name}},\n\nIt's that time of the month. I recommend shifting your low-lying furniture around to avoid uneven fading of your floor.\n\nIf you haven't swapped your office chair wheels to rubber/silicone ones yet, now's a good chance. Bunnings sell them (click [HERE](https://www.bunnings.com.au/ambassador-50mm-hooded-grey-rubber-office-chair-castor-2-pack_p3940116)) for under $10 a pair, much cheaper than repairing scuff marks.\n\nTo keep your floor looking the part, use a flat mop from Bunnings for under $30 (click [HERE](https://www.bunnings.com.au/decor-speed-350mm-misting-spray-floor-mop_p4460229)) with a timber floor cleaner like this one [HERE](https://www.bunnings.com.au/long-life-1l-timber-floor-cleaner_p4460500), or the cleaner of your choice. Always test in a hidden spot first, like a cupboard.\n\nWishing you the very best {{first_name}}, talk soon.\n\nPS: Don't forget to call if you have any questions. No question is a silly question."
  },
  {
    "code": "T3",
    "title": "Your floor should last 40 years",
    "audience": "engineered timber",
    "subject": "I hope you're not sick of me yet",
    "body": "{{first_name}}, I really hope you don't get sick of my emails. I never get sick of writing them, because this isn't really about me, it's about keeping your floor in tip-top condition.\n\nWith proper maintenance your floor can last 40 years, and I'd love to help you along the way. Here's the quick recap worth sticking on the fridge:\n\n- **Mop:** a flat mop (under $30 at Bunnings, click [HERE](https://www.bunnings.com.au/decor-speed-350mm-misting-spray-floor-mop_p4460229)) with a timber floor cleaner [HERE](https://www.bunnings.com.au/long-life-1l-timber-floor-cleaner_p4460500) or one of your choice. Barely damp, never wet, and never a steam mop. Test in a cupboard first.\n- **Felt pads** under all furniture (Bunnings, click [HERE](https://www.bunnings.com.au/syneco-felt-assorted-sizes-188-pack_p3962163)) so you can push things around without damage. Check them every few months. They wear and pick up grit.\n- **Office chairs:** rubber/silicone wheels, under $10 a pair (click [HERE](https://www.bunnings.com.au/ambassador-50mm-hooded-grey-rubber-office-chair-castor-2-pack_p3940116)).\n- **Moving the fridge?** Two 90 x 90cm pieces of 3mm MDF (one 1830 x 915 sheet cut in half, click [HERE](https://www.bunnings.com.au/customwood-mdf-1830-x-915-x-3mm-standard-mdf-panel_p0590074)) to leapfrog it across. Clean the floor first. Grit and timber don't mix.\n- **Door mats** at every outside door. Most scratches come from grit on shoes.\n- **No rugs for the first 12 months**, and never rubber-backed ones.\n- **Keep shuffling** low-lying furniture once a month.\n\nAny question big or small, email, SMS or call.\n\nTalk soon {{first_name}}."
  },
  {
    "code": "T5",
    "title": "Barefoot on your timber floor",
    "audience": "engineered timber",
    "subject": "Take your shoes off",
    "body": "Hey {{first_name}},\n\nJust thought I'd share something that really resonates with me: being barefoot, especially on something natural like your timber floor. Your floor is part of nature, and you should feel it. Here's a video from one of my favourite people to watch and learn from, Tony Riddle on London Real, \"Lose the Shoes\":\n\n{video}\n\nClick the picture to watch: https://www.youtube.com/watch?v=cpbeEDWa3Uw\n\nIt's also that time of the month again. Give your low-lying furniture a shuffle to avoid uneven fading. No rugs or mats for the first 12 months. You're nearly halfway there.\n\nAnd keep those floors clean. If you'd like me to resend the care info, just reply.\n\nWishing you the very best {{first_name}}, talk soon."
  },
  {
    "code": "T6",
    "title": "Happy birthday to your floor",
    "audience": "engineered timber, 12 months",
    "subject": "Happy birthday to your floor!",
    "body": "Hey {{first_name}},\n\nHappy birthday to your floor! Well, it's not really its birthday, but it has been 12 months, so I thought you could celebrate with a little TLC.\n\nThe good news: the first-year rules are done. Your floor has finished its main colour change, so you can now put rugs down if you like. Just avoid any with rubber backing, as it can react with the coating.\n\nTo keep it looking the part, use a flat mop (under $30 at Bunnings, click [HERE](https://www.bunnings.com.au/decor-speed-350mm-misting-spray-floor-mop_p4460229)) with a timber floor cleaner [HERE](https://www.bunnings.com.au/long-life-1l-timber-floor-cleaner_p4460500) or one of your choice. Test in a cupboard first.\n\nHere's to many more years, {{first_name}}."
  },
  {
    "code": "V1",
    "title": "Now you've settled in",
    "audience": "vinyl",
    "subject": "Looking after your new vinyl floor",
    "body": "Hi {{first_name}},\n\nNow that you've settled in and your furniture and ornaments are back in place, don't forget even the best floors need a bit of maintenance. For vinyl, we recommend at least a full mop once a month.\n\nThe manufacturers don't recommend steam mopping, so avoid it altogether.\n\nHonestly, vinyl is the easiest floor to maintain and you're going to love it!\n\nTwo important things:\n- **No rubber-backed mats directly on vinyl.** I've personally seen vinyl turn yellow within months. Silicone and foam mats are fine.\n- **The sun.** We all love it, but constant direct sun will discolour your floor over the years. Window tinting helps: and if you don't want the house darker, clear UV tint is quite inexpensive.\n\nAll the very best, and get in touch if you have any concerns."
  },
  {
    "code": "V2",
    "title": "Cleaning your vinyl without spending a fortune",
    "audience": "vinyl",
    "subject": "The cheapest, best vinyl floor cleaner",
    "body": "Hey {{first_name}},\n\nYour vinyl floor, like anything, needs a bit of TLC from time to time, but you don't need to spend a fortune on fancy floor cleaners. Many are just rebranded and charged at double or triple the price because of the label.\n\nI personally recommend Johnson's baby shampoo. It's pH neutral, as the manufacturers recommend, and it's gentle. A small squirt in a bucket of warm water is all you need.\n\nAs always, test it in a cupboard or a hidden spot before doing the whole floor.\n\nDon't forget I'm here for you, so any questions, I'm happy to answer them."
  },
  {
    "code": "H1",
    "title": "Long weekend",
    "audience": "seasonal, everyone",
    "subject": "Before you head off this long weekend",
    "body": "Hey {{first_name}},\n\nWe've got a long weekend coming up, so I thought I'd send you this quick email about turning off your dishwasher and washing machine taps if you're going away.\n\nRACQ alone has had around 10,000 water damage claims in the last 3 years, and most of them came from a broken dishwasher hose. A claim doesn't just push up your premium. Imagine coming home from a long weekend to a soaking wet mess.\n\nAll of this can be avoided by turning the tap clockwise until it's off.\n\nAnd to make sure you don't forget to turn it back on, just say \"Hey Siri (or Hey Google), remind me to turn the dishwasher tap on when I get home.\"\n\nSafe travels, talk soon {{first_name}}."
  },
  {
    "code": "H2",
    "title": "Christmas holidays",
    "audience": "seasonal, everyone",
    "subject": "A holiday story (and a $5,000 lesson)",
    "body": "Hi {{first_name}},\n\nWe're coming up to the holidays, which reminded me of a story a client told me years ago, after he went away with his wife in a caravan for a month over Christmas.\n\nLet's call him John. John always bought kilos of meat in bulk and kept it in the freezer. While they were away, an overnight lightning storm tripped the power. After weeks of sitting there, the meat created so much gas it popped the freezer door open, and guess who had a field day? The flies. They came home to maggots up to their ankles and had to call a crime-scene cleanup company. Luckily insurance covered the $5,000.\n\nIt's not a common thing, but having a relative, friend or neighbour pop in every few days to check on things is well worth it.\n\nThe other one is your taps that are always on, like the dishwasher and washing machine. A burst pipe lets out around 500 litres an hour, or 12,000 litres a day. In 5 days you could fill a large swimming pool. The most common culprit is braided hoses, which last about 5 years. If you moved into an existing home, it might be time to get a plumber to replace them.\n\nSo if you're going away for a while, or even a long weekend, turn off the mains water and get someone to pop their head in and check everything is A-OK.\n\nHave a safe and happy Christmas {{first_name}}."
  },
  {
    "code": "H4",
    "title": "Going away? Don't forget the fur babies",
    "audience": "holiday, everyone",
    "subject": "Going away? A quick one for the fur babies",
    "body": "Hi {{first_name}},\n\nSchool holidays are almost here, so if you're heading off, here's a quick checklist for the pets, and your floors.\n\n- **Pet sitter or neighbour feeding them?** Leave the water bowl on a tray, and maybe two bowls in case one gets knocked over. A tipped bowl that sits for days on timber, laminate or hybrid can swell the boards or turn them black, and on carpet it soaks through to the underlay.\n- **Pets staying inside?** Shut the doors to rooms you don't want them in, and put a washable mat or old towel where they normally sleep. Accidents happen when routines change.\n- **Automatic feeders and water fountains** are great, but test them for a few days before you go and sit them on a tray.\n- **Leave the sitter my number**, along with your vet's. If anything spills or a pipe leaks, getting onto it in the first day makes all the difference.\n\nAnd the usual: turn off the dishwasher and washing machine taps, and get someone to grab the mail and put the bins out.\n\nHave a great break {{first_name}}."
  },
  {
    "code": "H5",
    "title": "Shutting up the house in summer",
    "audience": "holiday, everyone",
    "subject": "Shutting the house up this long weekend?",
    "body": "Hi {{first_name}},\n\nWith the long weekend coming up, here's one most people don't think about: what a closed-up house does in a Queensland summer.\n\nA shut house in January gets hot and humid fast, and that's tough on floors and furnishings:\n- **Mould:** humid, still air can grow mould on carpet, rugs, wardrobes and leather in just a few days. Put a moisture absorber (like DampRid) in wardrobes and the main rooms, and don't leave damp towels or bath mats lying on the floor.\n- **Heat on floating floors:** direct sun through big windows onto laminate or hybrid in a closed, 40-degree house can make the boards expand and lift. Close the blinds on the sunny side before you go.\n- **Air-con:** if you have a timer or a dry mode, running it for an hour or two a day keeps the humidity down.\n- **If a neighbour is popping in,** ask them to open a couple of windows for an hour to air the place out.\n\nAnd of course: turn off the dishwasher and washing machine taps before you leave.\n\nEnjoy the long weekend {{first_name}}."
  },
  {
    "code": "H6",
    "title": "Your going-away checklist",
    "audience": "holiday, everyone",
    "subject": "Your 2-minute going-away checklist",
    "body": "Hi {{first_name}},\n\nSchool holidays and the King's Birthday long weekend are nearly here, so here's a quick checklist to run through before you lock the door:\n\n- ☐ Dishwasher and washing machine taps off (turn clockwise until tight), or the mains if you can\n- ☐ Fridge and freezer: get someone to check on them if you're away more than a few days (ask me about the freezer story one day!)\n- ☐ Neighbour or friend to grab the mail, put the bins out and pop their head in\n- ☐ Pets sorted, with water bowls on a tray\n- ☐ Blinds closed on the sunny side of the house\n- ☐ Pot plants off the floor or on stands (they need air underneath)\n- ☐ Contents insurance up to date. Remember carpet and floating floors usually count as contents\n\nHave a safe and happy break {{first_name}}."
  },
  {
    "code": "H3",
    "title": "School holidays",
    "audience": "seasonal, everyone",
    "subject": "Going away these school holidays?",
    "body": "Hi {{first_name}},\n\nAre you going away for a few weeks these school holidays with the kids?\n\nEveryone remembers to get the neighbours to grab the mail and put the bins out so the house doesn't look empty. What most people forget is the water. A burst pipe while you're away can fill a large swimming pool in less than five days.\n\nMost people also underestimate what it would cost to replace their contents. People often say \"$50,000 should do\", but forget about everyday things like cutlery, linen, clothes and books. These days an average 3 to 4 bedroom home would more likely cost $150,000 to $200,000 to refill. And carpet, laminate, vinyl and floating timber floors usually fall under contents insurance, not building insurance, because they aren't permanently fixed. Worth checking your policy.\n\nSo turn off your mains before you go. If you can't because your sprinklers are on automatic, at least turn off the washing machine and dishwasher taps. Follow the hose back to the tap and turn it clockwise until it's tight.\n\nDoing your floor again might be good for business, but it's not all about me. I've been through the upheaval myself, and that's why I send these reminders.\n\nSafe travels {{first_name}}."
  },
  {
    "code": "S1",
    "title": "Your freshly coated floor: the first 3 weeks",
    "audience": "floor sanding",
    "subject": "Your floor looks amazing, here's how to keep it that way",
    "body": "Hi {{first_name}},\n\nYour floor has just been sanded and coated, and right now the coating is still curing. It feels dry to touch, but it takes a few weeks to reach full hardness, and what you do in that time makes a big difference.\n\nAs a guide (your exact times depend on the coating we used, we'll have told you on the day):\n- **First 24 hours:** socks only, no shoes, and no pets.\n- **Day 3 to 7:** furniture can go back, but lift it into place (never drag it) and put felt pads on every leg first.\n- **First week:** no wet mopping. A soft broom or a vacuum with the hard-floor head is all it needs.\n- **First 2 to 3 weeks:** no rugs or mats of any kind. A rug traps the solvents and can leave a permanent patch, and rubber backing can mark the coating forever.\n- **Tape:** don't stick tape on the floor while it's curing. It can lift the coating when you peel it off.\n\nI know it's tempting to get everything back to normal straight away, but a little patience now means the coating will last years longer.\n\nAny questions at all, just call."
  },
  {
    "code": "S2",
    "title": "Rugs, pet bowls and sun on a coated floor",
    "audience": "floor sanding",
    "subject": "Three little things that wreck a beautiful floor",
    "body": "Hi {{first_name}},\n\nYour coating should be well and truly cured by now, so here are the three things I see damage freshly coated floors more than anything else.\n\n**1. Pet bowls.** Water bowls get splashed every single day, and that water sits under and around the bowl. Over time it gets into the edges of the boards and turns the timber grey or black. Put bowls on a tray or a washable mat (not rubber-backed) and wipe up splashes when you see them.\n\n**2. Rugs.** Rugs are fine now. Just use a felt or natural rug underlay, never rubber or latex backing, which reacts with the coating and leaves a yellow or sticky mark. Move rugs around every few months, because timber changes colour in the light and you'll end up with a \"rug-shaped\" patch.\n\n**3. Sun.** UV light changes the colour of timber over time: some darken, some lighten. It's natural, but full-height windows with no blinds will make it uneven. Close the blinds during the hottest part of the day, or look at clear UV window film, which blocks the UV without darkening your room.\n\nTalk soon {{first_name}}."
  },
  {
    "code": "S3",
    "title": "Keeping the coating looking new",
    "audience": "floor sanding",
    "subject": "The easiest way to make your coating last",
    "body": "Hi {{first_name}},\n\nThink of your floor coating like the clear coat on a car. It's what protects the timber, and grit is its worst enemy.\n\n- **Door mats** inside and outside every external door catch most of the grit before it gets to your floor.\n- **Vacuum or sweep** a couple of times a week. Grit under shoes acts like sandpaper.\n- **Damp mop only** with a pH-neutral timber floor cleaner. Barely damp, never wet, and never a steam mop. Steam forces moisture into the joins and can cloud the coating.\n- **Avoid** vinegar, bleach, ammonia and \"shine\" or polish products. They either dull the coating or leave a film that makes a future recoat difficult.\n- **Felt pads** wear out. Check them every few months and replace any that are flat or gritty.\n- **High heels and pet nails** dent and scratch the coating. Keep nails trimmed and kick the stilettos off at the door.\n\nDo this and your coating will look good for years."
  },
  {
    "code": "S4",
    "title": "One year on: your coating check-up",
    "audience": "floor sanding, 12 months",
    "subject": "Your floor's first birthday",
    "body": "Hi {{first_name}},\n\nIt's been 12 months since we sanded and coated your floor, so here's a quick check-up you can do yourself.\n\nHave a look at the busiest spots: in front of the kitchen sink, the doorways and the hallway. If the coating there still looks even and has a sheen, you're doing everything right.\n\nIf those areas are starting to look dull or slightly grey compared to under the couch, that's normal wear on the top layer. The good news is that while the wear is only in the coating, a light buff and a fresh maintenance coat brings it back without having to sand back to bare timber. Once the timber itself starts showing through, it needs a full sand, so it's worth keeping an eye on.\n\nKeep up the door mats, felt pads and damp mopping, and it will keep looking great.\n\nHere's to many more years, {{first_name}}."
  },
  {
    "code": "L1",
    "title": "Looking after your laminate or hybrid floor",
    "audience": "laminate and hybrid",
    "subject": "Looking after your new floor",
    "body": "Hi {{first_name}},\n\nNow that you've settled in, here's everything you need to keep your new floor looking like the day we laid it.\n\n- **Cleaning:** vacuum with the hard-floor head (not a beater bar), then a flat mop that is just damp. Wipe up spills straight away. Some laminates and most hybrids can handle more water than others, but no floating floor likes being flooded.\n- **Steam mops:** check before you use one. Most hybrids and many laminates are not steam-mop friendly, and steam can void the warranty. If you're unsure, ask me and I'll check your exact product.\n- **Cleaner:** a pH-neutral floor cleaner, nothing waxy or \"shine\" based. Those leave a film that gets slippery and dull.\n- **Felt pads** under every furniture leg, and rubber/silicone wheels on office chairs.\n- **Rubber-backed mats:** avoid them, especially on hybrid. The rubber reacts with the surface and can stain it yellow.\n- **Door mats** at outside doors. Grit is what scratches floors.\n\nAny questions, just call."
  },
  {
    "code": "L2",
    "title": "Heat, sun and that all-important gap",
    "audience": "laminate and hybrid",
    "subject": "Why your floor needs room to breathe",
    "body": "Hi {{first_name}},\n\nLaminate and hybrid floors are \"floating\" floors. They're not stuck down, so they move a tiny bit with heat and humidity. That's why we leave a small gap around the edges under the skirting or scotia. Here's how to keep that movement from causing problems:\n\n- **Don't pin it down.** Never screw, nail or silicone anything through the floor: kitchen islands, door stops, heavy cabinets. Pinning a floating floor stops it moving and it can lift or bow somewhere else.\n- **Keep the gaps clear.** Don't let anyone fill the edge gaps with silicone or caulk when they paint the skirting.\n- **Sun and heat.** In Queensland summer, direct afternoon sun through big windows can make the boards very hot and cause them to expand. Pull the blinds on the hottest days, especially if the house is closed up while you're at work.\n- **Humidity.** In the wet season, run the air-con or open the house up so moisture doesn't build up.\n- **Pot plants and water bowls.** Use a saucer or tray. Water left sitting can get into the joins.\n\nIf you ever notice joins lifting, gaps opening up, or a spot that feels spongy, let me know early. It's usually an easy fix when caught early."
  },
  {
    "code": "CT1",
    "title": "The best thing about carpet tiles",
    "audience": "carpet tiles",
    "subject": "Your floor's secret weapon",
    "body": "Hi {{first_name}},\n\nThe best thing about carpet tiles is that if something goes wrong, you don't need to replace the whole floor, you just swap a tile.\n\n- **Keep the spares** we left you somewhere dry and flat, with the box label. Tiles from a later batch can be a slightly different shade, so your spares are gold.\n- **Rotate tiles** in high-traffic spots every year or so. Swap them with tiles from under the bed or couch and the wear evens out.\n- **Vacuum** at least once a week, and treat spills straight away by blotting, never rubbing.\n- **To lift a tile,** grab a corner and peel it up. Most are held down with a tackifier, so the new one presses straight back in place.\n\nIf you ever need a hand swapping one, just call."
  },
  {
    "code": "C5",
    "title": "Carpet quirks that are completely normal",
    "audience": "carpet",
    "subject": "Is my carpet supposed to do that?",
    "body": "Hi {{first_name}},\n\nNew carpet does a few things that can look worrying but are completely normal. Here's what to expect:\n\n- **Fluff in the vacuum.** New carpet sheds loose fibres for the first few months. It's left over from manufacturing and settles down. It doesn't mean your carpet is wearing out.\n- **Shading.** Some areas look lighter or darker depending on which way the pile is brushed and where you're standing. It's the light hitting the fibres from different angles, just like brushing velvet one way and then the other. It's a natural feature, not a fault.\n- **A tuft sticking up (sprouting).** Never pull it out! Snip it level with the rest of the pile with sharp scissors.\n- **Furniture dents.** Pop an ice cube in the dent and let it melt, then fluff the pile up with your fingers or a spoon once it's damp. Gentle steam from an iron held above (never touching) works too.\n- **Seams.** There's no such thing as an invisible seam, and you may see a join in certain light. If a seam is opening up or fraying, though, let me know.\n\nHope that puts your mind at ease, {{first_name}}."
  },
  {
    "code": "A2",
    "title": "Why your floor looks different in different light",
    "audience": "all flooring",
    "subject": "Why your floor looks different at 4pm",
    "body": "Hi {{first_name}},\n\nHave you ever noticed your floor looks perfect at lunchtime, then late in the afternoon you can see every little mark, join or ripple?\n\nThat's the light, not the floor. When sunlight comes in low through a window or glass door, it skims across the surface and shows up things you'd never see from above: tiny dips in the slab, roller marks in a coating, the joins between boards, or shading in carpet. Downlights directly overhead hide almost everything, but side-on light shows everything.\n\nIt's the same reason a freshly painted wall looks perfect until the afternoon sun hits it.\n\nSo if something looks different at a certain time of day, have a look again at midday or with the blinds half closed. If it's still there, or you're unsure, send me a photo and I'll tell you honestly what I think."
  },
  {
    "code": "A3",
    "title": "Pets and your floor",
    "audience": "all flooring",
    "subject": "For the fur babies",
    "body": "Hi {{first_name}},\n\nWe love our pets, and with a little planning they and your floor can get along just fine.\n\n- **Water bowls:** put them on a tray or a washable mat (not rubber-backed). Splashes left sitting are one of the most common causes of floor damage I see, especially on timber, laminate and hybrid.\n- **Nails:** keep them trimmed. Long nails scratch timber and coatings and can snag carpet loops.\n- **Accidents:** clean them up straight away. On hard floors, wipe and dry it completely. Don't let it sit. On carpet, blot it dry, never rub, and use a pet stain cleaner. My stain tips email has the full method if you need it.\n- **Food bowls:** the same tray works. Fat and oil in pet food can mark coatings and carpet.\n- **Pet beds:** move them every now and then so one spot doesn't fade or flatten differently to the rest.\n\nGive them a pat from me, {{first_name}}."
  },
  {
    "code": "A4",
    "title": "Keep your spare boxes and product details",
    "audience": "all flooring",
    "subject": "The one thing to keep in your garage",
    "body": "Hi {{first_name}},\n\nThis is a small thing that can save you a lot of heartache down the track.\n\nKeep any spare boxes, planks, tiles or carpet offcuts we left you, plus the box label or product details. Store them somewhere dry and flat, not on a concrete garage floor where they can get damp.\n\nHere's why: flooring is made in batches, and colours change slightly from batch to batch. Products also get discontinued. If a plank gets damaged or a fridge leaks in five years, having a few spare boards from your original batch means a repair that disappears instead of one that sticks out.\n\nIf you're not sure what you've got, reply to this email and I'll send you the product name and colour from your job."
  },
  {
    "code": "A5",
    "title": "Pot plants on your floor",
    "audience": "all flooring",
    "subject": "The pot plant mistake I see every week",
    "body": "Hi {{first_name}},\n\nIndoor plants look beautiful, but they're one of the most common causes of floor damage I see.\n\nHere's the problem. Even with a saucer underneath, moisture builds up between the pot and the floor. Water seeps through the saucer, condensation forms underneath it, and with no air getting under there it never dries out.\n\n- **On carpet,** the backing and underlay stay damp and slowly rot, and you won't know until you move the pot and find a stained, smelly patch that can't be saved.\n- **On timber,** the moisture reacts with the tannins in the wood and turns it black. That stain goes right into the timber and won't sand out of most engineered boards.\n- **On laminate, hybrid and vinyl,** trapped moisture can swell the joins, cause mould underneath, or leave a cloudy ring.\n\nA plate or saucer on its own won't fix it. **What fixes it is air.** You need a gap between the pot and the floor so air can flow underneath and dry everything out.\n\n- Use a **plant stand with legs or feet** that lifts the pot at least 2 to 3cm off the floor, with the saucer sitting on the stand.\n- **Plant caddies on wheels** work well too, and make it easy to move big pots for cleaning.\n- Even three pot feet under the saucer are better than nothing.\n- Every few months, move the pot and check underneath.\n\nYour plants will thank you too. They drain better with air underneath."
  },
  {
    "code": "T7",
    "title": "How we repair timber floors",
    "audience": "engineered timber",
    "subject": "What happens if your timber floor gets damaged?",
    "body": "Hi {{first_name}},\n\nLife happens: a dropped cast-iron pan, a dog having zoomies, a leaking fridge. So I wanted you to know how timber floor repairs work, so you're never worried about it.\n\n**Light scuffs and fine scratches**\nMost of these are only in the top coating, not the timber. A colour-matched touch-up (a repair pen or wax filler) blends them in within a few seconds, and often you can't find the spot afterwards.\n\n**Deeper scratches, dents and gouges**\nIf it's gone into the timber, we don't try to patch it, because patches always show. Instead we **replace the board**. On a glued-down floor, we carefully cut out the damaged board, clean up the glue underneath, and glue a new board in from your spares. On a floating floor, we either unclick the boards back from the nearest wall or cut the damaged one out and splice a new one in. Done properly, you won't be able to tell which board was changed.\n\n**Water damage**\nIf water has got under the boards, call us straight away. Don't wait for it to dry. The sooner we see it, the more of the floor we can usually save.\n\n**Worn coating in busy areas**\nAfter some years, the walkways may look dull. If the wear is only in the coating, a light buff and a fresh maintenance coat brings it back. Depending on the veneer, some engineered floors can also be fully sanded and recoated.\n\nThis is exactly why I ask you to keep a few spare boards from your original batch. A board from the same batch makes the repair disappear.\n\nIf anything ever happens, just send me a photo and I'll tell you honestly what it needs."
  },
  {
    "code": "R1",
    "title": "Your carpet's busiest spots",
    "audience": "carpet",
    "subject": "Where your carpet works the hardest",
    "body": "Hey {{first_name}},\n\nEvery home has a few spots where the carpet does all the hard work: the doorway into the lounge, the path from the bed to the ensuite, in front of the couch. Those spots will show wear years before the rest of the room if they don't get a little extra attention.\n\n- **Vacuum the walkways twice as often** as the rest of the room. Go slowly. The suction needs time to lift the grit out from deep in the pile.\n- **Shuffle the furniture** a little every few months, so you're not walking in exactly the same line every day.\n- **Door mats** at every outside door. Most of the grit that wears carpet comes in on shoes.\n- **Shoes off inside**, if your family will go for it. It's the single biggest thing you can do.\n\n{if Wool or Loop pile} And remember: suction only on your carpet, no spin head. {/if}\n\nTalk soon {{first_name}}."
  },
  {
    "code": "R2",
    "title": "The 30-second stain rule",
    "audience": "carpet, carpet tiles",
    "subject": "What to do in the first 30 seconds of a spill",
    "body": "Hi {{first_name}},\n\nWhen something spills on carpet, what you do in the first 30 seconds matters more than any product you can buy. Here's the short version worth sticking on the fridge:\n\n1. **Blot, don't rub.** Press a clean white towel onto it and lift. Rubbing spreads it and pushes it down into the underlay.\n2. **Work from the outside in,** so you don't make the stain bigger.\n3. **Cold water first.** Hot water sets stains, especially blood and anything with protein in it.\n4. **Test anything stronger** in a hidden spot first, like inside a wardrobe.\n5. **Rinse and blot dry.** Leftover soap attracts dirt and makes the spot come back darker.\n\n{if Wool or Wool blend} Your carpet is wool, so no bleach, no oxy products, and only a little wool wash if you need more than water. {/if}\n\nIf it's something nasty or it won't budge, send me a photo before you try anything else and I'll tell you what's safe for your carpet."
  },
  {
    "code": "R3",
    "title": "Grit is the enemy",
    "audience": "hard floors",
    "subject": "The tiny thing that scratches floors",
    "body": "Hi {{first_name}},\n\nIf I had to pick the number one thing that damages hard floors, it isn't kids, pets or dropped plates. It's grit: the tiny bits of sand and dirt that come in on shoes and act like sandpaper every time someone walks over them.\n\nThe good news is it's the easiest thing to beat:\n- **A good door mat outside and inside** every external door. Most grit drops off in the first few steps.\n- **Sweep or vacuum** a couple of times a week, more in summer when sand comes home from the beach.\n- **Check your felt pads.** Over time they flatten and pick up grit, then they scratch instead of protect. Swap any that look tired.\n- **Rubber or silicone wheels** on office chairs, never plastic.\n\nLiving on the Gold Coast, sand is part of life: so a few minutes a week makes a big difference.\n\nTalk soon {{first_name}}."
  },
  {
    "code": "R4",
    "title": "Moving furniture without wrecking your floor",
    "audience": "all flooring",
    "subject": "Rearranging the furniture? Read this first",
    "body": "Hi {{first_name}},\n\nMoving furniture around is one of the most common ways floors get damaged, and it's almost always from dragging. Here's how to do it safely:\n\n- **Lift, don't drag.** Get a second person for anything heavy.\n- **Felt pads on every leg** before the furniture goes back down.\n- **The fridge trick:** buy one 1830 x 915 x 3mm MDF sheet from Bunnings and cut it in half. Slide the fridge onto one piece, then onto the other, and leapfrog it across the room. Clean the floor first so there's no grit under the boards.\n- **Heavy items on carpet:** move them a few centimetres every now and then so the carpet doesn't get permanent dents. If you get a dent, an ice cube left to melt in it, then fluffing the pile up, usually brings it back.\n- **Floating floors:** don't screw anything heavy, like a kitchen island or cabinet, through the floor. It needs room to move.\n\nHappy rearranging {{first_name}}."
  },
  {
    "code": "R5",
    "title": "Three things that turn vinyl yellow",
    "audience": "vinyl",
    "subject": "Three things your vinyl floor hates",
    "body": "Hi {{first_name}},\n\nVinyl is the easiest floor to live with, but there are three things that can turn it yellow or cloudy, and once it happens it can't be reversed.\n\n1. **Rubber.** Rubber-backed mats, rubber feet on furniture, even car tyres in a garage react with the vinyl's wear layer and stain it yellow, sometimes within months. Use silicone, foam or felt instead.\n2. **Steam mops.** The heat and moisture can cloud the surface and get into the joins. A flat mop with warm water and a little pH-neutral cleaner (a drop of baby shampoo works) is all you need.\n3. **Constant direct sun.** Years of strong sun through big windows will fade and discolour it. Blinds on the hottest part of the day, or clear UV window film, prevents it without darkening the room.\n\nAvoid those three and your floor will look great for years."
  },
  {
    "code": "R6",
    "title": "Spills, steam and your floating floor",
    "audience": "laminate, hybrid",
    "subject": "How much water can your floor really take?",
    "body": "Hi {{first_name}},\n\nPeople often ask me how waterproof their floor really is, so here's the honest answer.\n\nMany laminates and hybrids are sold as water resistant or waterproof on top, and that's true: a spill sitting on the surface for a while won't hurt it. The weak spots are the **joins and the edges**. If water gets down between the boards or under the skirting, it can swell the core or sit underneath with nowhere to go.\n\n- Wipe up spills when you see them, especially near the dishwasher, fridge and sink.\n- Mop with a flat mop that's just damp, never soaking wet.\n- Check your product before using a steam mop. Most aren't designed for it.\n- If the dishwasher or fridge ever leaks, pull it out and dry everything straight away, and let me know if any boards look swollen.\n\nTalk soon {{first_name}}."
  },
  {
    "code": "R7",
    "title": "Spring clean your floors",
    "audience": "all flooring, September",
    "subject": "A spring clean for your floors",
    "body": "Hi {{first_name}},\n\nSpring's here, so if you're giving the house a once-over, here's a quick floor checklist:\n\n- ☐ Move the couch and beds and vacuum underneath. That's where dust and carpet beetles like to hide.\n- ☐ Check and replace any worn felt pads.\n- ☐ Lift and shake out door mats, or replace them if they're flat.\n- ☐ Check under pot plants. They need a stand with an air gap, not just a saucer.\n- ☐ Check under the dishwasher and fridge for any slow leaks.\n- ☐ Carpet: if it's coming up to 12 months since its last professional clean, book it in now before summer.\n- ☐ Timber and coated floors: a damp mop with a pH-neutral timber cleaner, never a steam mop.\n\nEnjoy the sunshine {{first_name}}."
  },
  {
    "code": "R8",
    "title": "Wet season floors",
    "audience": "all flooring, January, February",
    "subject": "Storm season and your floors",
    "body": "Hi {{first_name}},\n\nIt's the wettest, most humid time of the year in Queensland, and that's when floors need a bit of extra care.\n\n- **Wet shoes and umbrellas:** leave them at the door on a mat or tray. Water sitting on timber, laminate or hybrid can get into the joins.\n- **Humidity:** timber and floating floors swell slightly when the air is wet. That's normal, but running the air-con or a dehumidifier on muggy days keeps it under control. If you notice boards lifting or gaps closing up, let me know.\n- **Mould:** closed-up rooms and damp carpet are a mould magnet. Air the house out when you can, and don't leave wet towels or bath mats on the floor.\n- **Storms:** if water ever comes in under a door or through a window, dry it out as fast as you can and call me. The first 24 hours make all the difference.\n\nStay dry {{first_name}}."
  },
  {
    "code": "R9",
    "title": "Before the painters or tradies arrive",
    "audience": "all flooring",
    "subject": "Having work done at home? Protect your floors first",
    "body": "Hi {{first_name}},\n\nIf you've got painters, electricians or any other tradies coming, a few minutes of prep can save your floors.\n\n- **Cover the walkways** with drop sheets or builder's paper, especially between the door and where they're working.\n- **No sticky tape directly on timber or coated floors.** It can lift the coating when it comes off. Tape the protection to itself instead.\n- **Painters and skirting:** ask them not to fill the gap between a floating floor and the skirting with caulk or silicone. The floor needs that gap to move.\n- **Ladders and trestles:** ask for rubber or padded feet, and never drag them.\n- **Grit and plaster dust** scratch hard floors, so a quick vacuum at the end of each day helps.\n\nIf anything does get damaged, take a photo straight away and send it to me."
  },
  {
    "code": "R10",
    "title": "Between tenants: a 5-minute carpet check",
    "audience": "carpet, landlords",
    "subject": "A quick carpet check between tenants",
    "body": "Hi {{first_name}},\n\nIf your rental is between tenants, or you're doing a routine inspection, here's a quick 5-minute carpet check that can save you replacing it early.\n\n- **Look at the walkways** (doorways, hallway, in front of the couch). Are they darker or flatter than the rest? That's soil build-up, and it means a professional clean is due.\n- **Check the cleaning receipts.** Manufacturers require a professional clean every 12 months (18 at the most), and they will ask for receipts if there's ever a claim.\n- **Look for pet and water stains**, especially near doors, the kitchen and under pot plants.\n- **Check the seams and edges.** Anything lifting or fraying is much cheaper to fix early.\n\nA well-maintained rental carpet can last twice as long. That's a big difference to your return."
  }
];

export const CARE_TEMPLATE_MAP: ReadonlyMap<string, CareTemplate> = new Map(CARE_TEMPLATES.map((t) => [t.code, t]));
