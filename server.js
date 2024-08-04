const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const db = require('./db');
const bcrypt = require('bcrypt');

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json());

app.get('/health', async (req, res) => {
    try {
        await db.one('SELECT 1');
        res.status(200).send('Ready!!');
    } catch (err) {
        res.status(500).send('Internal Server Error');
    }
});

app.post('/create-patient', async (req, res) => {
    const patient = req.body;
    try {
        await db.tx(async t => {
            const patientId = await t.one(`INSERT INTO patient (
                title_name, first_name, last_name, id_card, phone, gender, date_birth,
                house_number, street, village, subdistrict, district, province,
                weight, height, waist, password
            ) VALUES (
                $[title_name], $[first_name], $[last_name], $[id_card], $[phone], $[gender], $[date_birth],
                $[house_number], $[street], $[village], $[subdistrict], $[district], $[province],
                $[weight], $[height], $[waist], $[password]
            ) RETURNING id`, patient);

            const bmiValue = calculateBMI(patient.weight, patient.height);
            await t.none(`INSERT INTO bmi_records (patient_id, bmi) VALUES ($1, $2)`, [patientId.id, bmiValue]);

            const hashedPassword = await bcrypt.hash(patient.password, 10);
            await t.none(`INSERT INTO users (id_card, password) VALUES ($[id_card], $[password])`, {
                id_card: patient.id_card,
                password: hashedPassword
            });
        });

        res.status(200).json({ message: 'Patient and user created successfully' });
    } catch (err) {
        console.error('Error creating patient:', err);
        res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
});

function calculateBMI(weight, height) {
    return (weight / ((height / 100) * (height / 100))).toFixed(2);
}

app.post('/login', async (req, res) => {
    const { id_card, password } = req.body;
    try {
      const user = await db.oneOrNone('SELECT * FROM users WHERE id_card = $1', [id_card]);
      if (user && await bcrypt.compare(password, user.password)) {
        const patient = await db.one('SELECT id FROM patient WHERE id_card = $1', [id_card]);
        res.status(200).json({ id: patient.id.toString() }); // Ensure id is sent as a string
      } else {
        res.status(401).json({ message: 'Invalid ID Card or Password' });
      }
    } catch (err) {
      console.error('Error during login:', err);
      res.status(500).json({ message: 'Internal Server Error' });
    }
  });
  
  
app.get('/profile/:id', async (req, res) => {
    const patientId = req.params.id;
    try {
        const profileData = await db.one(`
            SELECT 
                p.title_name,
                p.first_name,
                p.last_name,
                p.id_card,
                p.phone,
                p.gender,
                p.date_birth,
                p.house_number,
                p.street,
                p.village,
                p.subdistrict,
                p.district,
                p.province,
                p.weight,
                p.height,
                p.waist,
                b.bmi
            FROM patient p
            LEFT JOIN bmi_records b ON p.id = b.patient_id
            WHERE p.id = $1
            ORDER BY b.record_date DESC
            LIMIT 1;
        `, [patientId]);
        res.status(200).json(profileData);
    } catch (err) {
        console.error('Error fetching profile:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});