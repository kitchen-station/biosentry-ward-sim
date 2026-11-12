// Synthetic names: plain common Filipino surnames and given names, drawn at random, so no name is a real person's.
// Names live only on a person record, never on an event or an hourly row.
// Slice A3: 400 surnames, 150 given names per sex, 26 initials (3,120,000 names). Rules, each held by a test in hospital.test.ts:
// no duplicates, ASCII letters only, no surname of a national office holder's family, no famous full pair, no vulgar word.
export const SURNAMES = [
  "Santos", "Reyes", "Cruz", "Bautista", "Ocampo", "Mendoza", "Villanueva", "Gomez", "Castillo", "Rivera",
  "Flores", "Gonzales", "Torres", "Fernandez", "Lopez", "Martinez", "Perez", "Navarro", "Domingo", "Manalo",
  "Salazar", "Valdez", "Soriano", "Mercado", "Santiago", "Lim", "Tan", "Pascual", "Alvarez", "Aguilar",
  "Castro", "Diaz", "Evangelista", "Francisco", "Guevarra", "Hernandez", "Ignacio", "Jimenez", "Herrera", "Macaraeg",
  "Nicolas", "Ortega", "Padilla", "Chavez", "Robles", "Morales", "Tuazon", "Umali", "Velasco", "Yap",
  "Zamora", "Abad", "Bernardo", "Cabrera", "David", "Enriquez", "Feliciano", "Gutierrez", "Hilario", "Javier",
  "Lorenzo", "Magno", "Natividad", "Olivares", "Ramirez", "Quiambao", "Rosales", "Salvador", "Trinidad", "Urbano",
  "Vergara", "Mendez", "Zaragoza", "Andrada", "Corpuz", "Dizon", "Espiritu", "Fajardo", "Abella", "Abrenica",
  "Acosta", "Adriano", "Agbayani", "Agno", "Aguirre", "Alcantara", "Alejandro", "Alonzo", "Amparo", "Ancheta",
  "Andaya", "Angeles", "Antonio", "Apolinario", "Aquilino", "Arellano", "Arevalo", "Arguelles", "Arias", "Atienza",
  "Austria", "Ayala", "Baguio", "Balagtas", "Balbuena", "Baldonado", "Ballesteros", "Banal", "Barcelona", "Barrientos",
  "Barrios", "Basa", "Batac", "Bayani", "Belmonte", "Beltran", "Benitez", "Bernal", "Bondoc", "Borja",
  "Buenaventura", "Bueno", "Bugayong", "Bustamante", "Caballero", "Cabading", "Cacho", "Cadiz", "Calderon", "Calma",
  "Calub", "Camacho", "Campos", "Candelaria", "Canlas", "Capili", "Carandang", "Cardenas", "Carino", "Carpio",
  "Carreon", "Casimiro", "Castaneda", "Catalan", "Cayabyab", "Celis", "Cervantes", "Chua", "Clemente", "Collado",
  "Concepcion", "Conde", "Consunji", "Contreras", "Cordero", "Cortez", "Crisostomo", "Cuenca", "Cunanan", "Custodio",
  "Dacanay", "Dagdag", "Dalisay", "Dayrit", "Decena", "Dejesus", "Delgado", "Deocampo", "Desiderio", "Dimaculangan",
  "Dimaano", "Dionisio", "Doria", "Duran", "Echavez", "Elizalde", "Encarnacion", "Escobar", "Escudero", "Esguerra",
  "Eslava", "Esteban", "Estacio", "Fabian", "Fabros", "Falcon", "Farinas", "Felipe", "Ferrer", "Fontanilla",
  "Franco", "Fuentes", "Gabriel", "Galang", "Galvez", "Gamboa", "Garrido", "Gatchalian", "Gaerlan", "Geronimo",
  "Gonzaga", "Guerrero", "Guinto", "Gumabao", "Hermosa", "Hidalgo", "Honrado", "Ibarra", "Idica", "Ilagan",
  "Infante", "Isidro", "Jacinto", "Jaen", "Jaramillo", "Labrador", "Ladia", "Lagman", "Landicho", "Lapuz",
  "Laqui", "Larano", "Lazaro", "Legaspi", "Leonardo", "Liwanag", "Llamas", "Lobo", "Lomibao", "Lualhati",
  "Lumbre", "Lustre", "Macapinlac", "Maceda", "Madrid", "Magat", "Magsino", "Malabanan", "Malonzo", "Mangahas",
  "Manalang", "Manansala", "Mangubat", "Manzano", "Maranan", "Marasigan", "Mariano", "Marquez", "Matias", "Medina",
  "Mejia", "Menor", "Mijares", "Miranda", "Molina", "Montalbo", "Montano", "Montenegro", "Montes", "Mora",
  "Moreno", "Munoz", "Nacpil", "Nadal", "Narvaez", "Nepomuceno", "Nieto", "Nolasco", "Nunez", "Oliva",
  "Oliveros", "Ongpin", "Opena", "Orbeta", "Ordonez", "Orozco", "Ortiz", "Osorio", "Pacheco", "Palma",
  "Panganiban", "Parada", "Paras", "Paredes", "Patricio", "Pangan", "Peralta", "Pineda", "Pimentel", "Pizarro",
  "Policarpio", "Ponce", "Portillo", "Prado", "Prieto", "Puno", "Quijano", "Quilala", "Quinto", "Quitoriano",
  "Rabago", "Racelis", "Ramiro", "Regalado", "Remigio", "Resurreccion", "Reyna", "Ricafort", "Rigor", "Rivas",
  "Rocha", "Roldan", "Romero", "Roque", "Rosario", "Ruiz", "Saavedra", "Sabado", "Sagun", "Salas",
  "Salcedo", "Samonte", "Sanchez", "Sandoval", "Sarmiento", "Sebastian", "Segovia", "Serrano", "Sevilla", "Silva",
  "Solano", "Solis", "Sotelo", "Suarez", "Sumulong", "Tabora", "Tadeo", "Tagle", "Talavera", "Tamayo",
  "Tangco", "Tapia", "Tejada", "Teodoro", "Tiongson", "Tirado", "Toledo", "Tomas", "Torralba", "Trillana",
  "Tupas", "Ubaldo", "Uy", "Valencia", "Valera", "Valiente", "Vargas", "Vasquez", "Velarde", "Venturina",
  "Vera", "Vicente", "Victoriano", "Villafuerte", "Villamor", "Villareal", "Villegas", "Viray", "Vizcarra", "Yambao",
  "Ybarra", "Yulo", "Zabala", "Zafra", "Zapanta", "Zialcita", "Bacani", "Badilla", "Bagtas", "Balderas",
  "Banzon", "Bartolome", "Bello", "Bernabe", "Blanco", "Briones", "Cabral", "Cabanilla", "Dumlao", "Espino",
  "Fabella", "Gaston", "Hilado", "Imperial", "Jover", "Kalaw", "Lapitan", "Mabalot", "Nolledo", "Oracion",
];

export const GIVEN = {
  F: [
    "Maria", "Luz", "Carmen", "Nenita", "Imelda", "Josefina", "Remedios", "Teresita", "Rosario", "Lourdes",
    "Rosalinda", "Aurora", "Cecilia", "Dolores", "Elena", "Felicidad", "Gloria", "Herminia", "Isabel", "Juanita",
    "Leonora", "Marites", "Norma", "Olivia", "Perla", "Rowena", "Sofia", "Tessie", "Ursula", "Violeta",
    "Wilma", "Yolanda", "Zenaida", "Amelia", "Beatriz", "Cristina", "Delia", "Erlinda", "Flordeliza", "Gemma",
    "Adelaida", "Agnes", "Alma", "Amparo", "Angelina", "Annabelle", "Antonia", "Araceli", "Belen", "Benilda",
    "Bernadette", "Bonifacia", "Camila", "Carina", "Carolina", "Catalina", "Cherry", "Concepcion", "Corazon", "Cynthia",
    "Daisy", "Dalisay", "Dina", "Divina", "Edna", "Eliza", "Emelita", "Emilia", "Esperanza", "Estela",
    "Eufemia", "Evelyn", "Fe", "Fidela", "Florencia", "Fortunata", "Gina", "Giselle", "Graciela", "Gwen",
    "Hazel", "Helen", "Hilda", "Ines", "Irene", "Jasmine", "Jocelyn", "Josephine", "Joy", "Julieta",
    "Karen", "Katrina", "Lani", "Lea", "Leticia", "Liza", "Lorna", "Loida", "Lucia", "Luzviminda",
    "Madelyn", "Magdalena", "Maribel", "Marilou", "Marissa", "Marlene", "Melanie", "Mercedes", "Milagros", "Mila",
    "Minerva", "Mylene", "Nancy", "Natividad", "Nelia", "Nora", "Oliva", "Pacita", "Patricia", "Paz",
    "Pilar", "Priscilla", "Purita", "Rachelle", "Raquel", "Rebecca", "Reina", "Rhea", "Rita", "Rochelle",
    "Rosalie", "Rosita", "Ruby", "Sandra", "Shiela", "Socorro", "Susana", "Tala", "Tina", "Trinidad",
    "Vilma", "Virginia", "Vivian", "Zeny", "Zita", "Aileen", "Charlene", "Dorothy", "Faye", "Gladys",
  ],
  M: [
    "Jose", "Ramon", "Antonio", "Danilo", "Ernesto", "Rogelio", "Marcelo", "Benjamin", "Carlos", "Dominador",
    "Reynaldo", "Fernando", "Gregorio", "Honorio", "Ismael", "Jaime", "Lorenzo", "Manuel", "Narciso", "Orlando",
    "Pedro", "Rodolfo", "Salvador", "Teodoro", "Victor", "Vicente", "Wilfredo", "Zoilo", "Arnel", "Bernardo",
    "Cesar", "Dante", "Efren", "Felipe", "Gilbert", "Hernan", "Ignacio", "Julio", "Leonardo", "Abelardo",
    "Adrian", "Alberto", "Alfredo", "Alvin", "Amado", "Andres", "Angelito", "Anselmo", "Armando", "Arturo",
    "Augusto", "Aurelio", "Baldwin", "Benito", "Bienvenido", "Celso", "Ceferino", "Clarence", "Crisanto", "Cristobal",
    "Daniel", "Darius", "Dennis", "Dionisio", "Domingo", "Edgardo", "Edmundo", "Eduardo", "Eladio", "Elmer",
    "Emmanuel", "Enrico", "Ernie", "Esteban", "Eugenio", "Fabian", "Federico", "Florante", "Francisco", "Froilan",
    "Gabriel", "Gerardo", "Gilberto", "Glenn", "Guillermo", "Gustavo", "Harold", "Henry", "Herminio", "Hilario",
    "Hipolito", "Ian", "Isidro", "Jaycee", "Jerome", "Jesus", "Joel", "Jonathan", "Joselito", "Juancho",
    "Jun", "Kenneth", "Lamberto", "Lauro", "Lino", "Louie", "Lucio", "Luis", "Macario", "Mario",
    "Mark", "Martin", "Mateo", "Mauricio", "Melchor", "Mel", "Miguel", "Nestor", "Noel", "Norberto",
    "Oscar", "Pablo", "Patricio", "Paulo", "Placido", "Prudencio", "Rafael", "Randy", "Raul", "Renato",
    "Ricardo", "Rico", "Rizalino", "Roberto", "Rolando", "Romeo", "Ronaldo", "Rosendo", "Rufino", "Samuel",
    "Santiago", "Sergio", "Silvestre", "Tomas", "Ulysses", "Valentin", "Virgilio", "Wenceslao", "Xavier", "Zaldy",
  ],
};

// The 80 x 80 pool from before A3: used only while `PARAMS.returns.enabled` is off, so older outputs can be reproduced byte for byte.
const OLD_SURNAMES = [
  "Santos", "Reyes", "Cruz", "Bautista", "Ocampo", "Mendoza", "Villanueva", "Gomez", "Castillo", "Ramos",
  "Rivera", "Flores", "Gonzales", "Torres", "Fernandez", "Lopez", "Martinez", "Perez", "Navarro", "Domingo",
  "Manalo", "Salazar", "Valdez", "Soriano", "Tolentino", "Mercado", "Santiago", "Lim", "Tan", "Pascual",
  "Alvarez", "Aguilar", "Castro", "Diaz", "Evangelista", "Francisco", "Guevarra", "Hernandez", "Ignacio", "Jimenez",
  "Herrera", "Macaraeg", "Nicolas", "Ortega", "Padilla", "Chavez", "Robles", "Morales", "Tuazon", "Umali",
  "Velasco", "Yap", "Zamora", "Abad", "Bernardo", "Cabrera", "David", "Enriquez", "Feliciano", "Gutierrez",
  "Hilario", "Javier", "Lorenzo", "Magno", "Natividad", "Olivares", "Ramirez", "Quiambao", "Rosales", "Salvador",
  "Trinidad", "Urbano", "Vergara", "Mendez", "Zaragoza", "Andrada", "Corpuz", "Dizon", "Espiritu", "Fajardo",
];

const OLD_GIVEN = {
  F: [
    "Maria", "Luz", "Carmen", "Nenita", "Imelda", "Josefina", "Remedios", "Teresita", "Rosario", "Lourdes",
    "Rosalinda", "Aurora", "Cecilia", "Dolores", "Elena", "Felicidad", "Gloria", "Herminia", "Isabel", "Juanita",
    "Leonora", "Marites", "Norma", "Olivia", "Perla", "Rowena", "Sofia", "Tessie", "Ursula", "Violeta",
    "Wilma", "Yolanda", "Zenaida", "Amelia", "Beatriz", "Cristina", "Delia", "Erlinda", "Flordeliza", "Gemma",
  ],
  M: [
    "Jose", "Ramon", "Antonio", "Danilo", "Ernesto", "Rogelio", "Marcelo", "Benjamin", "Carlos", "Dominador",
    "Reynaldo", "Fernando", "Gregorio", "Honorio", "Ismael", "Jaime", "Lorenzo", "Manuel", "Narciso", "Orlando",
    "Pedro", "Quirino", "Rodolfo", "Salvador", "Teodoro", "Victor", "Vicente", "Wilfredo", "Zoilo", "Arnel",
    "Bernardo", "Cesar", "Dante", "Efren", "Felipe", "Gilbert", "Hernan", "Ignacio", "Julio", "Leonardo",
  ],
};

export const LEGACY = { SURNAMES: OLD_SURNAMES, GIVEN: OLD_GIVEN };

export const INITIALS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
