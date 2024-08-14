// backend
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
        patient.id_card = patient.id_card.replace(/-/g, '');
        patient.phone = patient.phone.replace(/-/g, '');

        await db.tx(async t => {
            const patientId = await t.one(`
                INSERT INTO patient (
                    title_name, first_name, last_name, id_card, phone, gender, date_birth,
                    house_number, street, village, subdistrict, district, province,
                    weight, height, waist, password
                ) VALUES (
                    $[title_name], $[first_name], $[last_name], $[id_card], $[phone], $[gender], $[date_birth],
                    $[house_number], $[street], $[village], $[subdistrict], $[district], $[province],
                    $[weight], $[height], $[waist], $[password]
                ) RETURNING id`, patient);

            const bmiValue = calculateBMI(patient.weight, patient.height);
            const waistToHeightRatio = calculateWaistToHeightRatio(patient.waist, patient.height);

            await t.none(`
                INSERT INTO health_data (patient_id, bmi, waist_to_height_ratio) 
                VALUES ($1, $2, $3)`, 
                [patientId.id, bmiValue, waistToHeightRatio]);

            const hashedPassword = await bcrypt.hash(patient.password, 10);
            await t.none(`
                INSERT INTO users (id_card, password) 
                VALUES ($[id_card], $[password])`, {
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

function calculateWaistToHeightRatio(waist, height) {
    return (waist / height).toFixed(2);
}

function formatIdCard(idCard) {
    return idCard.replace(/(\d{1})(\d{4})(\d{5})(\d{2})(\d{1})/, '$1-$2-$3-$4-$5');
}

function formatPhone(phone) {
    return phone.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
}

app.post('/login', async (req, res) => {
    const { id_card, password } = req.body;
    try {
        const formattedIdCard = id_card.replace(/-/g, '');
        const user = await db.oneOrNone('SELECT * FROM users WHERE id_card = $1', [formattedIdCard]);
        if (user && await bcrypt.compare(password, user.password)) {
            const patient = await db.one('SELECT id, title_name, first_name, last_name FROM patient WHERE id_card = $1', [formattedIdCard]);
            res.status(200).json({ 
                id: patient.id.toString(),
                title_name: patient.title_name,
                first_name: patient.first_name,
                last_name: patient.last_name
            });
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
                p.id,
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
                h.bmi,
                h.waist_to_height_ratio
            FROM patient p
            LEFT JOIN health_data h ON p.id = h.patient_id
            WHERE p.id = $1
            ORDER BY h.record_date DESC
            LIMIT 1;
        `, [patientId]);

        // Format id_card and phone with dashes before sending response
        profileData.id_card = formatIdCard(profileData.id_card);
        profileData.phone = formatPhone(profileData.phone);

        res.status(200).json(profileData);      
    } catch (err) {
        console.error('Error fetching profile:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

app.put('/profile/:id', async (req, res) => {
    const patientId = req.params.id;
    const updatedData = req.body;

    try {
        // Remove dashes from id_card and phone before saving to the database
        updatedData.id_card = updatedData.id_card.replace(/-/g, '');
        updatedData.phone = updatedData.phone.replace(/-/g, '');
        
        await db.tx(async t => {
            // Update patient information
            await t.none(`
                UPDATE patient
                SET
                    title_name = $[title_name],
                    first_name = $[first_name],
                    last_name = $[last_name],
                    id_card = $[id_card],
                    phone = $[phone],
                    gender = $[gender],
                    date_birth = $[date_birth],
                    house_number = $[house_number],
                    street = $[street],
                    village = $[village],
                    subdistrict = $[subdistrict],
                    district = $[district],
                    province = $[province],
                    weight = $[weight],
                    height = $[height],
                    waist = $[waist]
                WHERE id = $[patientId]
            `, { ...updatedData, patientId });

            // Calculate new BMI and waist_to_height_ratio
            const bmiValue = calculateBMI(updatedData.weight, updatedData.height);
            const waistToHeightRatio = calculateWaistToHeightRatio(updatedData.waist, updatedData.height);

            // Check if a record exists in health_data
            const existingRecord = await t.oneOrNone(`
                SELECT 1 FROM health_data WHERE patient_id = $1
            `, [patientId]);

            if (existingRecord) {
                // If exists, update the record
                await t.none(`
                    UPDATE health_data 
                    SET bmi = $2, waist_to_height_ratio = $3
                    WHERE patient_id = $1
                `, [patientId, bmiValue, waistToHeightRatio]);
            } else {
                // If not exists, insert a new record
                await t.none(`
                    INSERT INTO health_data (patient_id, bmi, waist_to_height_ratio) 
                    VALUES ($1, $2, $3)
                `, [patientId, bmiValue, waistToHeightRatio]);
            }

            res.status(200).json({ message: 'Profile updated successfully' });
        });
    } catch (err) {
        console.error('Error updating profile:', err);
        res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
});

// Route สำหรับบันทึกผลการประเมิน
app.post('/evaluation-results', async (req, res) => {
    const { user_id, program_name, result_program } = req.body;
    try {
        const result = await db.one(`
            INSERT INTO appointments (user_id, program_name, result_program, appointment_date) 
            VALUES ($1, $2, $3, NULL) 
            RETURNING id`, [user_id, program_name, result_program]);
        res.status(201).json({ id: result.id });
    } catch (err) {
        res.status(500).json({ message: 'Error creating evaluation result', error: err.message });
    }
});

// Route สำหรับการสร้างการนัดหมายพร้อมผลการประเมิน (หรือไม่พร้อม)
app.post('/create-appointment-with-result', async (req, res) => {
    const { user_id, program_name, result_program, appointment_date } = req.body;
    try {
        const result = await db.one(`
            INSERT INTO appointments (user_id, program_name, result_program, appointment_date) 
            VALUES ($1, $2, $3, $4) 
            RETURNING id`, [user_id, program_name, result_program, appointment_date]);
        res.status(201).json({ id: result.id });
    } catch (err) {
        res.status(500).json({ message: 'Error creating appointment with result', error: err.message });
    }
});

// Route สำหรับการสร้างการนัดหมายโดยไม่ต้องมีผลการประเมิน (นัดล่วงหน้า)
app.post('/create-appointment', async (req, res) => {
    const { user_id, program_name, appointment_date } = req.body;
    try {
        const result = await db.one(`
            INSERT INTO appointments (user_id, program_name, result_program, appointment_date) 
            VALUES ($1, $2, NULL, $3) 
            RETURNING id`, [user_id, program_name, appointment_date]);
        res.status(201).json({ id: result.id });
    } catch (err) {
        res.status(500).json({ message: 'Error creating appointment', error: err.message });
    }
});

app.get('/appointments-with-date/:user_id', async (req, res) => {
    const userId = req.params.user_id;
    try {
        const appointments = await db.any(`
            SELECT id, user_id, program_name, appointment_date
            FROM appointments
            WHERE appointment_date IS NOT NULL AND user_id = $1
            ORDER BY appointment_date DESC
            LIMIT 1
        `, [userId]);

        res.status(200).json(appointments);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching appointments', error: err.message });
    }
});

app.get('/appointments-date-all/:user_id', async (req, res) => {
    const userId = req.params.user_id;
    try {
        const appointments = await db.any(`
            SELECT id, user_id, program_name, appointment_date
            FROM appointments
            WHERE appointment_date IS NOT NULL AND user_id = $1
            ORDER BY appointment_date DESC
        `, [userId]);

        res.status(200).json(appointments);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching appointments', error: err.message });
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
