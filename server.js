// backend
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const db = require('./db');
const bcrypt = require('bcrypt');
const thaiDatabase = require('./thai_database.json');

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.json());

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
            const patient = await db.oneOrNone('SELECT id, title_name, first_name, last_name FROM patient WHERE id_card = $1', [formattedIdCard]);

            if (patient) {
                res.status(200).json({ 
                    id: patient.id.toString(),
                    title_name: patient.title_name,
                    first_name: patient.first_name,
                    last_name: patient.last_name
                });
            } else {
                res.status(404).json({ message: 'Patient not found' });
            }
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
            // Get the old id_card before updating
            const oldData = await t.oneOrNone('SELECT id_card FROM patient WHERE id = $1', [patientId]);
            const oldIdCard = oldData.id_card;

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
                    province = $[province]
                WHERE id = $[patientId]
            `, { ...updatedData, patientId });

            // Update users information (id_card) ถ้ามีการเปลี่ยนแปลง
            if (oldIdCard !== updatedData.id_card) {
                await t.none(`
                    UPDATE users
                    SET id_card = $[id_card]
                    WHERE id_card = $[oldIdCard]
                `, { id_card: updatedData.id_card, oldIdCard });
            }

            // Check if password needs to be updated
            if (updatedData.password) {
                const hashedPassword = await bcrypt.hash(updatedData.password, 10);
                await t.none(`
                    UPDATE users
                    SET password = $[hashedPassword]
                    WHERE id_card = $[id_card]
                `, { hashedPassword, id_card: updatedData.id_card });
            }

            res.status(200).json({ message: 'Profile and user updated successfully' });
        });
    } catch (err) {
        console.error('Error updating profile and user:', err);
        res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
});


app.put('/profile/:id/health', async (req, res) => {
    const patientId = req.params.id;
    const updatedHealthData = req.body;

    try {
        await db.tx(async t => {
            // Update weight, height, waist in patient table
            await t.none(`
                UPDATE patient
                SET 
                    weight = $[weight],
                    height = $[height],
                    waist = $[waist]
                WHERE id = $[patientId]
            `, {
                patientId: patientId,
                weight: updatedHealthData.weight,
                height: updatedHealthData.height,
                waist: updatedHealthData.waist
            });

            // Calculate BMI and waist-to-height ratio
            const bmi = calculateBMI(updatedHealthData.weight, updatedHealthData.height);
            const waistToHeightRatio = calculateWaistToHeightRatio(updatedHealthData.waist, updatedHealthData.height);

            // Check if a health_data record exists
            const existingHealthData = await t.oneOrNone(`
                SELECT id FROM health_data WHERE patient_id = $1
            `, [patientId]);

            if (existingHealthData) {
                // Update health data if exists
                await t.none(`
                    UPDATE health_data 
                    SET bmi = $[bmi], waist_to_height_ratio = $[waist_to_height_ratio]
                    WHERE patient_id = $[patientId]
                `, {
                    patientId: patientId,
                    bmi: bmi,
                    waist_to_height_ratio: waistToHeightRatio
                });
            } else {
                // Insert new health data if not exists
                await t.none(`
                    INSERT INTO health_data (patient_id, bmi, waist_to_height_ratio) 
                    VALUES ($[patientId], $[bmi], $[waist_to_height_ratio])
                `, {
                    patientId: patientId,
                    bmi: bmi,
                    waist_to_height_ratio: waistToHeightRatio
                });
            }

            res.status(200).json({ message: 'Health data updated successfully' });
        });
    } catch (err) {
        console.error('Error updating health data:', err);
        res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
});

app.post('/evaluation-results', async (req, res) => {
    const { user_id, program_name, result_program, appointment_date } = req.body;
    try {
        const result = await db.one(`
            INSERT INTO appointments (user_id, program_name, result_program, appointment_date) 
            VALUES ($1, $2, $3, $4) 
            RETURNING id`, [user_id, program_name, result_program, appointment_date]);
        res.status(201).json({ id: result.id });
    } catch (err) {
        res.status(500).json({ message: 'Error creating evaluation result', error: err.message });
    }
});


app.post('/create-appointment', async (req, res) => {
    const { user_id, program_name, appointment_date } = req.body;

    try {
        const formattedDate = moment(appointment_date, 'DD/MM/YYYY').format('YYYY-MM-DD');
        
        const result = await db.one(`
            INSERT INTO appointments (user_id, program_name, result_program, appointment_date) 
            VALUES ($1, $2, NULL, $3) 
            RETURNING id`, [user_id, program_name, formattedDate]);
        
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
            ORDER BY appointment_date ASC 
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

app.delete('/appointments/:id', async (req, res) => {
    const appointmentId = req.params.id;

    try {
        await db.none('DELETE FROM appointments WHERE id = $1', [appointmentId]);
        res.status(200).json({ message: 'Appointment deleted successfully' });
    } catch (err) {
        console.error('Error deleting appointment:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

app.put('/change-password/:id', async (req, res) => {
    const userId = req.params.id;
    const { new_password } = req.body;
  
    try {
      const hashedPassword = await bcrypt.hash(new_password, 10);
  
      await db.tx(async t => {
        // อัปเดตรหัสผ่านในตาราง users
        await t.none(`
          UPDATE users
          SET password = $1
          WHERE id_card = (
            SELECT id_card FROM patient WHERE id = $2
          )
        `, [hashedPassword, userId]);
  
        // อัปเดตรหัสผ่านในตาราง patient
        await t.none(`
          UPDATE patient
          SET password = $1
          WHERE id = $2
        `, [hashedPassword, userId]);
  
        // บันทึกประวัติการแก้ไขรหัสผ่านในตาราง password_changes
        await t.none(`
          INSERT INTO password_changes (user_id, patient_id)
          VALUES (
            (SELECT id FROM users WHERE id_card = (SELECT id_card FROM patient WHERE id = $1)),
            $1
          )
        `, [userId]);
  
        res.status(200).json({ message: 'Password updated successfully' });
      });
    } catch (err) {
      console.error('Error updating password:', err);
      res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
});

app.get('/appointments/web', async (req, res) => {
    try {
        const appointments = await db.any(`
            SELECT
                a.id,
                a.user_id,
                p.first_name, 
                p.last_name, 
                p.phone, 
                a.program_name,
                a.result_program,
                a.appointment_date
            FROM 
                patient p 
            JOIN 
                users u ON p.id_card = u.id_card
            JOIN 
                appointments a ON u.id = a.user_id
            ORDER BY 
                a.appointment_date ASC;
        `);

        res.status(200).json(appointments);
    } catch (err) {
        console.error('Error fetching appointments:', err);
        res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
});

app.get('/appointments/details/:id', async (req, res) => {
    const appointmentId = req.params.id;
    try {
        const appointmentDetails = await db.one(`
            SELECT 
                p.first_name, 
                p.last_name, 
                p.phone, 
                p.id_card, 
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
                h.waist_to_height_ratio, 
                a.program_name, 
                a.result_program -- ดึง result_program จากตาราง appointments
            FROM 
                patient p
            JOIN 
                users u ON p.id_card = u.id_card
            JOIN 
                appointments a ON u.id = a.user_id
            LEFT JOIN 
                health_data h ON p.id = h.patient_id
            WHERE 
                a.id = $1
        `, [appointmentId]);

        res.status(200).json(appointmentDetails);
    } catch (err) {
        console.error('Error fetching appointment details:', err);
        res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
});

app.get('/districts/:province', (req, res) => {
    const { province } = req.params;
    const districts = [...new Set(thaiDatabase.filter(data => data.province === province).map(data => data.amphoe))]; // ดึงอำเภอจากจังหวัดที่เลือก
    res.json(districts);
});
  
app.get('/subdistricts/:district', (req, res) => {
    const { district } = req.params;
    const subdistricts = thaiDatabase.filter(data => data.amphoe === district).map(data => data.district); // ดึงตำบลจากอำเภอที่เลือก
    res.json(subdistricts);
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
