/* Hand-checked franchise lists, in release order. [type, title, year]: "m" = movie, "t" = series.
   They are looked up on TMDB by name and year the first time someone opens "Show related films & series".
   To add a franchise: copy a block, list its titles, and put the collection names in `match`
   (the collection name without the word "collection", lower case). */
const FRANCHISES = [
  {
    id: "mcu",
    match: ["the avengers", "avengers", "iron man", "thor", "captain america", "guardians of the galaxy", "ant man", "black panther", "doctor strange",
            "captain marvel", "the marvels", "spider man marvel cinematic universe", "spider man mcu", "marvel cinematic universe", "shang chi", "black widow",
            "the incredible hulk", "eternals", "deadpool", "the fantastic four", "thunderbolts"],
    items: [
      ["m", "Iron Man", 2008], ["m", "The Incredible Hulk", 2008], ["m", "Iron Man 2", 2010], ["m", "Thor", 2011], ["m", "Captain America: The First Avenger", 2011],
      ["m", "The Avengers", 2012], ["m", "Iron Man 3", 2013], ["m", "Thor: The Dark World", 2013], ["m", "Captain America: The Winter Soldier", 2014],
      ["m", "Guardians of the Galaxy", 2014], ["m", "Avengers: Age of Ultron", 2015], ["m", "Ant-Man", 2015], ["m", "Captain America: Civil War", 2016],
      ["m", "Doctor Strange", 2016], ["m", "Guardians of the Galaxy Vol. 2", 2017], ["m", "Spider-Man: Homecoming", 2017], ["m", "Thor: Ragnarok", 2017],
      ["m", "Black Panther", 2018], ["m", "Avengers: Infinity War", 2018], ["m", "Ant-Man and the Wasp", 2018], ["m", "Captain Marvel", 2019],
      ["m", "Avengers: Endgame", 2019], ["m", "Spider-Man: Far From Home", 2019], ["m", "Black Widow", 2021], ["m", "Shang-Chi and the Legend of the Ten Rings", 2021],
      ["m", "Eternals", 2021], ["m", "Spider-Man: No Way Home", 2021], ["m", "Doctor Strange in the Multiverse of Madness", 2022], ["m", "Werewolf by Night", 2022],
      ["m", "Thor: Love and Thunder", 2022], ["m", "Black Panther: Wakanda Forever", 2022], ["m", "The Guardians of the Galaxy Holiday Special", 2022],
      ["m", "Ant-Man and the Wasp: Quantumania", 2023], ["m", "Guardians of the Galaxy Vol. 3", 2023], ["m", "The Marvels", 2023], ["m", "Deadpool & Wolverine", 2024],
      ["m", "Captain America: Brave New World", 2025], ["m", "Thunderbolts*", 2025], ["m", "The Fantastic Four: First Steps", 2025],
      ["m", "Spider-Man: Brand New Day", 2026], ["m", "Avengers: Doomsday", 2026], ["m", "Avengers: Secret Wars", 2027],
      // Marvel Television (ABC, Netflix, Hulu, Freeform)
      ["t", "Agents of S.H.I.E.L.D.", 2013], ["t", "Agent Carter", 2015], ["t", "Daredevil", 2015], ["t", "Jessica Jones", 2015], ["t", "Luke Cage", 2016],
      ["t", "Iron Fist", 2017], ["t", "The Defenders", 2017], ["t", "The Punisher", 2017], ["t", "Inhumans", 2017], ["t", "Runaways", 2017],
      ["t", "Cloak & Dagger", 2018], ["t", "Helstrom", 2020],
      // Marvel Studios (Disney+)
      ["t", "WandaVision", 2021], ["t", "The Falcon and the Winter Soldier", 2021], ["t", "Loki", 2021], ["t", "What If...?", 2021], ["t", "Hawkeye", 2021],
      ["t", "Moon Knight", 2022], ["t", "Ms. Marvel", 2022], ["t", "She-Hulk: Attorney at Law", 2022], ["t", "Secret Invasion", 2023], ["t", "Echo", 2024],
      ["t", "X-Men '97", 2024], ["t", "Agatha All Along", 2024], ["t", "Daredevil: Born Again", 2025], ["t", "Ironheart", 2025], ["t", "Eyes of Wakanda", 2025],
      ["t", "Marvel Zombies", 2025], ["t", "Your Friendly Neighborhood Spider-Man", 2025], ["t", "Wonder Man", 2026], ["t", "VisionQuest", 2026],
    ],
  },
  {
    id: "star-wars",
    match: ["star wars", "star wars skywalker saga", "the mandalorian"],
    items: [
      ["m", "Star Wars", 1977], ["m", "The Empire Strikes Back", 1980], ["m", "Return of the Jedi", 1983], ["m", "The Phantom Menace", 1999],
      ["m", "Attack of the Clones", 2002], ["m", "Revenge of the Sith", 2005], ["m", "Star Wars: The Clone Wars", 2008], ["m", "The Force Awakens", 2015],
      ["m", "Rogue One: A Star Wars Story", 2016], ["m", "The Last Jedi", 2017], ["m", "Solo: A Star Wars Story", 2018], ["m", "The Rise of Skywalker", 2019],
      ["m", "The Mandalorian & Grogu", 2026], ["m", "Star Wars: Starfighter", 2027],
      ["t", "Star Wars: The Clone Wars", 2008], ["t", "Star Wars Rebels", 2014], ["t", "Star Wars Resistance", 2018], ["t", "The Mandalorian", 2019],
      ["t", "Star Wars: Visions", 2021], ["t", "Star Wars: The Bad Batch", 2021], ["t", "The Book of Boba Fett", 2021], ["t", "Obi-Wan Kenobi", 2022],
      ["t", "Andor", 2022], ["t", "Star Wars: Tales of the Jedi", 2022], ["t", "Ahsoka", 2023], ["t", "Star Wars: Young Jedi Adventures", 2023],
      ["t", "Star Wars: Tales of the Empire", 2024], ["t", "The Acolyte", 2024], ["t", "Star Wars: Skeleton Crew", 2024], ["t", "Star Wars: Tales of the Underworld", 2025],
      ["t", "Maul – Shadow Lord", 2026],
    ],
  },
  {
    id: "john-wick",
    match: ["john wick"],
    items: [
      ["m", "John Wick", 2014], ["m", "John Wick: Chapter 2", 2017], ["m", "John Wick: Chapter 3 - Parabellum", 2019], ["m", "John Wick: Chapter 4", 2023],
      ["m", "Ballerina", 2025], ["t", "The Continental: From the World of John Wick", 2023],
    ],
  },
  {
    id: "middle-earth",
    match: ["the lord of the rings", "the hobbit", "lord of the rings"],
    items: [
      ["m", "The Lord of the Rings: The Fellowship of the Ring", 2001], ["m", "The Lord of the Rings: The Two Towers", 2002], ["m", "The Lord of the Rings: The Return of the King", 2003],
      ["m", "The Hobbit: An Unexpected Journey", 2012], ["m", "The Hobbit: The Desolation of Smaug", 2013], ["m", "The Hobbit: The Battle of the Five Armies", 2014],
      ["t", "The Lord of the Rings: The Rings of Power", 2022], ["m", "The Lord of the Rings: The War of the Rohirrim", 2024],
      ["m", "The Lord of the Rings: The Hunt for Gollum", 2027],
    ],
  },
  {
    id: "wizarding-world",
    match: ["harry potter", "fantastic beasts"],
    items: [
      ["m", "Harry Potter and the Philosopher's Stone", 2001], ["m", "Harry Potter and the Chamber of Secrets", 2002], ["m", "Harry Potter and the Prisoner of Azkaban", 2004],
      ["m", "Harry Potter and the Goblet of Fire", 2005], ["m", "Harry Potter and the Order of the Phoenix", 2007], ["m", "Harry Potter and the Half-Blood Prince", 2009],
      ["m", "Harry Potter and the Deathly Hallows: Part 1", 2010], ["m", "Harry Potter and the Deathly Hallows: Part 2", 2011],
      ["m", "Fantastic Beasts and Where to Find Them", 2016], ["m", "Fantastic Beasts: The Crimes of Grindelwald", 2018], ["m", "Fantastic Beasts: The Secrets of Dumbledore", 2022],
    ],
  },
  {
    id: "naruto",
    name: "Naruto",
    match: ["naruto", "boruto"],
    items: [
      ["t", "Naruto", 2002], ["m", "Naruto the Movie: Ninja Clash in the Land of Snow", 2004], ["m", "Naruto the Movie 2: Legend of the Stone of Gelel", 2005],
      ["m", "Naruto the Movie 3: Guardians of the Crescent Moon Kingdom", 2006], ["t", "Naruto Shippuden", 2007, 31910], ["m", "Naruto Shippuden the Movie", 2007],
      ["m", "Naruto Shippuden the Movie: Bonds", 2008], ["m", "Naruto Shippuden the Movie: The Will of Fire", 2009], ["m", "Naruto Shippuden the Movie: The Lost Tower", 2010],
      ["m", "Naruto Shippuden the Movie: Blood Prison", 2011], ["t", "Naruto SD: Rock Lee & His Ninja Pals", 2012], ["m", "Road to Ninja: Naruto the Movie", 2012],
      ["m", "The Last: Naruto the Movie", 2014], ["m", "Boruto: Naruto the Movie", 2015], ["t", "Boruto: Naruto Next Generations", 2017],
      ["t", "Boruto: Two Blue Vortex", 2025],
    ],
  },
  {
    id: "dragon-ball",
    name: "Dragon Ball",
    match: ["dragon ball"],
    items: [
      ["t", "Dragon Ball", 1986], ["t", "Dragon Ball Z", 1989], ["t", "Dragon Ball GT", 1996], ["t", "Dragon Ball Z Kai", 2009], ["t", "Dragon Ball Super", 2015],
      ["t", "Dragon Ball Daima", 2024],
      ["m", "Dragon Ball: Curse of the Blood Rubies", 1986], ["m", "Dragon Ball: Sleeping Princess in Devil's Castle", 1987], ["m", "Dragon Ball: Mystical Adventure", 1988],
      ["m", "Dragon Ball Z: Dead Zone", 1989], ["m", "Dragon Ball Z: The World's Strongest", 1990], ["m", "Dragon Ball Z: The Tree of Might", 1990],
      ["m", "Dragon Ball Z: Lord Slug", 1991], ["m", "Dragon Ball Z: Cooler's Revenge", 1991], ["m", "Dragon Ball Z: The Return of Cooler", 1992],
      ["m", "Dragon Ball Z: Super Android 13!", 1992], ["m", "Dragon Ball Z: Broly - The Legendary Super Saiyan", 1993], ["m", "Dragon Ball Z: Bojack Unbound", 1993],
      ["m", "Dragon Ball Z: Broly - Second Coming", 1994], ["m", "Dragon Ball Z: Bio-Broly", 1994], ["m", "Dragon Ball Z: Fusion Reborn", 1995],
      ["m", "Dragon Ball Z: Wrath of the Dragon", 1995], ["m", "Dragon Ball: The Path to Power", 1996], ["m", "Dragon Ball Z: Battle of Gods", 2013],
      ["m", "Dragon Ball Z: Resurrection 'F'", 2015], ["m", "Dragon Ball Super: Broly", 2018], ["m", "Dragon Ball Super: Super Hero", 2022],
    ],
  },
  {
    id: "bleach",
    name: "Bleach",
    match: ["bleach"],
    items: [
      ["t", "Bleach", 2004], ["m", "Bleach: Memories of Nobody", 2006], ["m", "Bleach the Movie: The DiamondDust Rebellion", 2007], ["m", "Bleach: Fade to Black", 2008],
      ["m", "Bleach: Hell Verse", 2010], ["t", "Bleach: Thousand-Year Blood War", 2022],
    ],
  },
  {
    id: "fullmetal-alchemist",
    name: "Fullmetal Alchemist",
    match: ["fullmetal alchemist"],
    items: [
      ["t", "Fullmetal Alchemist", 2003], ["m", "Fullmetal Alchemist the Movie: Conqueror of Shamballa", 2005], ["t", "Fullmetal Alchemist: Brotherhood", 2009],
      ["m", "Fullmetal Alchemist: The Sacred Star of Milos", 2011],
    ],
  },
  {
    id: "hunter-x-hunter",
    name: "Hunter x Hunter",
    match: ["hunter x hunter"],
    items: [
      ["t", "Hunter x Hunter", 1999], ["t", "Hunter x Hunter", 2011], ["m", "Hunter x Hunter: Phantom Rouge", 2013], ["m", "Hunter x Hunter: The Last Mission", 2013],
    ],
  },
];
