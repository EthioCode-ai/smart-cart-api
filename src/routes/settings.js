// src/screens/SettingsScreen.js
// Settings — Dietary restrictions, allergens, family members, favorite stores, history
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, RefreshControl, Alert, Modal, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, FONTS, SPACING, RADIUS, SHADOWS } from '../config';
import { Card } from '../components/SharedComponents';
import useAuthStore from '../store/authStore';
import api from '../services/api';

// ─── Option Lists ───
const DIETARY_OPTIONS = ['vegetarian', 'vegan', 'gluten-free', 'dairy-free', 'keto', 'paleo', 'halal', 'kosher', 'low-sodium', 'low-sugar'];
const ALLERGEN_OPTIONS = ['nuts', 'peanuts', 'shellfish', 'fish', 'eggs', 'milk', 'soy', 'wheat', 'sesame', 'sulfites'];

// ─── Removable Chip ───
const RemovableChip = ({ label, onRemove, color = 'green' }) => {
  const bgColor = color === 'green' ? COLORS.primaryLight : '#FEE2E2';
  const textColor = color === 'green' ? COLORS.primary : '#DC2626';

  return (
    <View style={[styles.chip, { backgroundColor: bgColor }]}>
      <Text style={[styles.chipText, { color: textColor }]}>{label}</Text>
      <TouchableOpacity onPress={onRemove} style={styles.chipClose}>
        <Ionicons name="close" size={14} color={textColor} />
      </TouchableOpacity>
    </View>
  );
};

// ─── Dropdown Add ───
const DropdownAdd = ({ placeholder, options, selectedItems, onAdd }) => {
  const [open, setOpen] = useState(false);
  const availableOptions = options.filter((o) => !selectedItems.includes(o));

  return (
    <View style={styles.dropdownContainer}>
      <TouchableOpacity
        style={styles.dropdownBtn}
        onPress={() => setOpen(!open)}
      >
        <Text style={styles.dropdownPlaceholder}>{placeholder}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={COLORS.textSecondary} />
      </TouchableOpacity>

      {open && availableOptions.length > 0 && (
        <ScrollView style={styles.dropdownList} nestedScrollEnabled>
          {availableOptions.map((option) => (
            <TouchableOpacity
              key={option}
              style={styles.dropdownItem}
              onPress={() => {
                onAdd(option);
                setOpen(false);
              }}
            >
              <Text style={styles.dropdownItemText}>{option}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
};

// ─── Section Header ───
const SectionHeader = ({ icon, title }) => (
  <View style={styles.sectionHeader}>
    <Ionicons name={icon} size={20} color={COLORS.text} />
    <Text style={styles.sectionTitle}>{title}</Text>
  </View>
);

// ─── Family Member Card ───
const FamilyMemberCard = ({ member, onRemove }) => (
  <View style={styles.familyCard}>
    <View style={styles.familyInfo}>
      <Text style={styles.familyName}>{member.name}</Text>
      <Text style={styles.familyRole}>{member.role}</Text>
      <View style={styles.familyDietaryRow}>
        {(member.dietary || []).map((d) => (
          <View key={d} style={styles.familyDietaryChip}>
            <Text style={styles.familyDietaryText}>{d}</Text>
          </View>
        ))}
      </View>
    </View>
    <TouchableOpacity onPress={() => onRemove?.(member.id)} style={styles.deleteBtn}>
      <Ionicons name="trash-outline" size={20} color={COLORS.textTertiary} />
    </TouchableOpacity>
  </View>
);

// ─── Add Family Member Modal ───
const AddFamilyModal = ({ visible, onClose, onAdd }) => {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');

  const handleAdd = () => {
    if (!name.trim()) {
      Alert.alert('Missing Name', 'Please enter a name.');
      return;
    }
    onAdd?.({ name: name.trim(), role: role.trim(), dietary: [] });
    setName('');
    setRole('');
    onClose?.();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Add Family Member</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color={COLORS.textSecondary} />
            </TouchableOpacity>
          </View>

          <Text style={styles.inputLabel}>Name</Text>
          <TextInput
            style={styles.textInput}
            value={name}
            onChangeText={setName}
            placeholder="Enter name"
            placeholderTextColor={COLORS.textTertiary}
          />

          <Text style={styles.inputLabel}>Role (optional)</Text>
          <TextInput
            style={styles.textInput}
            value={role}
            onChangeText={setRole}
            placeholder="e.g., Spouse, Child, Parent"
            placeholderTextColor={COLORS.textTertiary}
          />

          <TouchableOpacity style={styles.primaryBtn} onPress={handleAdd}>
            <Text style={styles.primaryBtnText}>Add Member</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

// ─── Favorite Store Card ───
const FavoriteStoreCard = ({ store, onRemove }) => (
  <View style={styles.storeCard}>
    <View style={styles.storeInfo}>
      <Text style={styles.storeName}>{store.name}</Text>
      <Text style={styles.storeNote}>{store.note}</Text>
    </View>
    <TouchableOpacity onPress={() => onRemove?.(store.id)} style={styles.deleteBtn}>
      <Ionicons name="trash-outline" size={20} color={COLORS.textTertiary} />
    </TouchableOpacity>
  </View>
);

// ─── History Item ───
const HistoryItem = ({ item }) => (
  <View style={styles.historyItem}>
    <View style={styles.historyLeft}>
      <View style={styles.historyIconRow}>
        <Ionicons name="location" size={16} color={COLORS.primary} />
        <Text style={styles.historyStore}>{item.store}</Text>
      </View>
      <Text style={styles.historyDate}>{item.date}</Text>
      {item.note && <Text style={styles.historyNote}>{item.note}</Text>}
    </View>
    <View style={styles.historyRight}>
      <Text style={styles.historyAmount}>${item.amount.toFixed(2)}</Text>
      <Text style={styles.historyItems}>{item.items} items</Text>
    </View>
  </View>
);

// ═══════════════════════════════════════════════════
//  MAIN SETTINGSSCREEN
// ═══════════════════════════════════════════════════
export default function SettingsScreen({ navigation }) {
  const { logout, user } = useAuthStore();

  // State — loaded from API, not mock data
  const [dietary, setDietary] = useState([]);
  const [allergens, setAllergens] = useState([]);
  const [family, setFamily] = useState([]);
  const [stores, setStores] = useState([]);
  const [history] = useState([]);

  const [familyModalVisible, setFamilyModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // ── Load settings from API ──
  const loadSettings = async () => {
    try {
      const response = await api.get('/api/settings');
      const settings = response.settings || response;
      setDietary(settings.dietaryRestrictions || []);
      setAllergens(settings.allergens || []);
      setFamily(settings.familyMembers || []);
      setStores(settings.favoriteStores || []);
      setHasChanges(false);
    } catch (err) {
      console.error('Load settings error:', err);
      // Start with empty — no mocks
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadSettings();
    setRefreshing(false);
  }, []);

  // ── Save to API ──
  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put('/api/settings', {
        dietaryRestrictions: dietary,
        allergens: allergens,
      });
      setHasChanges(false);
      Alert.alert('Saved!', 'Your settings have been updated.');
    } catch (err) {
      console.error('Save settings error:', err);
      Alert.alert('Error', 'Failed to save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // Dietary
  const handleAddDietary = (item) => {
    setDietary([...dietary, item]);
    setHasChanges(true);
  };
  const handleRemoveDietary = (item) => {
    setDietary(dietary.filter((d) => d !== item));
    setHasChanges(true);
  };

  // Allergens
  const handleAddAllergen = (item) => {
    setAllergens([...allergens, item]);
    setHasChanges(true);
  };
  const handleRemoveAllergen = (item) => {
    setAllergens(allergens.filter((a) => a !== item));
    setHasChanges(true);
  };

  // Family
  const handleAddFamily = (member) => {
    setFamily([...family, { ...member, id: Date.now().toString() }]);
  };
  const handleRemoveFamily = (id) => {
    Alert.alert('Remove Member', 'Are you sure you want to remove this family member?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => setFamily(family.filter((f) => f.id !== id)) },
    ]);
  };

  // Stores
  const handleAddStore = () => {
    Alert.alert('Add Store', 'Search and add a store from the Stores tab.');
  };
  const handleRemoveStore = (id) => {
    Alert.alert('Remove Store', 'Remove this store from favorites?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => setStores(stores.filter((s) => s.id !== id)) },
    ]);
  };

  // Logout
  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Logout', style: 'destructive', onPress: () => logout() },
    ]);
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />
      }
    >
      {/* Header */}
      <View style={styles.header}>
        <Ionicons name="settings-outline" size={28} color={COLORS.primary} />
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      {/* Dietary Restrictions */}
      <Card style={[styles.section, { zIndex: 20, elevation: 20 }]}>  
        <SectionHeader icon="leaf-outline" title="Dietary Restrictions" />
        <View style={styles.chipsRow}>
          {dietary.length === 0 && (
            <Text style={styles.emptyText}>None set</Text>
          )}
          {dietary.map((d) => (
            <RemovableChip key={d} label={d} onRemove={() => handleRemoveDietary(d)} color="green" />
          ))}
        </View>
        <DropdownAdd
          placeholder="Add dietary restriction"
          options={DIETARY_OPTIONS}
          selectedItems={dietary}
          onAdd={handleAddDietary}
        />
      </Card>

      {/* Allergens */}
      <Card style={[styles.section, { zIndex: 10, elevation: 10 }]}>
        <SectionHeader icon="alert-circle-outline" title="Allergens & Food Sensitivities" />
        <View style={styles.chipsRow}>
          {allergens.length === 0 && (
            <Text style={styles.emptyText}>None set</Text>
          )}
          {allergens.map((a) => (
            <RemovableChip key={a} label={a} onRemove={() => handleRemoveAllergen(a)} color="red" />
          ))}
        </View>
        <DropdownAdd
          placeholder="Add allergen"
          options={ALLERGEN_OPTIONS}
          selectedItems={allergens}
          onAdd={handleAddAllergen}
        />
      </Card>

      {/* Save Button */}
      <TouchableOpacity
        style={[styles.saveBtn, !hasChanges && styles.saveBtnDisabled]}
        onPress={handleSave}
        disabled={!hasChanges || saving}
      >
        {saving ? (
          <ActivityIndicator size="small" color={COLORS.white} />
        ) : (
          <>
            <Ionicons name="checkmark-circle" size={20} color={COLORS.white} />
            <Text style={styles.saveBtnText}>
              {hasChanges ? 'Save Changes' : 'All Saved'}
            </Text>
          </>
        )}
      </TouchableOpacity>

      {/* Family Members */}
      <Card style={styles.section}>
        <SectionHeader icon="people-outline" title="Family Members" />
        {family.length === 0 && (
          <Text style={styles.emptyText}>No family members added</Text>
        )}
        {family.map((member) => (
          <FamilyMemberCard key={member.id} member={member} onRemove={handleRemoveFamily} />
        ))}
        <TouchableOpacity
          style={styles.addRowBtn}
          onPress={() => setFamilyModalVisible(true)}
        >
          <Ionicons name="add" size={18} color={COLORS.textSecondary} />
          <Text style={styles.addRowText}>Add Family Member</Text>
        </TouchableOpacity>
      </Card>

      {/* Favorite Stores */}
      <Card style={styles.section}>
        <SectionHeader icon="heart-outline" title="Favorite Stores" />
        {stores.length === 0 && (
          <Text style={styles.emptyText}>No favorite stores</Text>
        )}
        {stores.map((store) => (
          <FavoriteStoreCard key={store.id} store={store} onRemove={handleRemoveStore} />
        ))}
        <TouchableOpacity style={styles.addRowBtn} onPress={handleAddStore}>
          <Ionicons name="add" size={18} color={COLORS.textSecondary} />
          <Text style={styles.addRowText}>Add Favorite Store</Text>
        </TouchableOpacity>
      </Card>

      {/* Recent Shopping History */}
      {history.length > 0 && (
        <Card style={styles.section}>
          <SectionHeader icon="time-outline" title="Recent Shopping History" />
          {history.map((item) => (
            <HistoryItem key={item.id} item={item} />
          ))}
        </Card>
      )}

      {/* Logout Button */}
      <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
        <Ionicons name="log-out-outline" size={20} color={COLORS.red} />
        <Text style={styles.logoutText}>Logout</Text>
      </TouchableOpacity>

      <View style={{ height: SPACING.xxxl * 2 }} />

      {/* Add Family Modal */}
      <AddFamilyModal
        visible={familyModalVisible}
        onClose={() => setFamilyModalVisible(false)}
        onAdd={handleAddFamily}
      />
    </ScrollView>
  );
}

// ─── Styles ───
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  contentContainer: { padding: SPACING.lg },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.background },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    marginBottom: SPACING.xl, paddingTop: SPACING.sm,
  },
  headerTitle: { ...FONTS.h2, fontWeight: '700' },

  // Section
  section: { marginBottom: SPACING.lg },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  sectionTitle: { ...FONTS.bodyMedium, fontWeight: '700' },
  emptyText: { ...FONTS.bodySm, color: COLORS.textTertiary, marginBottom: SPACING.sm },

  // Chips
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginBottom: SPACING.md },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: SPACING.sm, paddingVertical: 6,
    borderRadius: RADIUS.full,
  },
  chipText: { ...FONTS.caption, fontWeight: '600' },
  chipClose: { marginLeft: 2 },

  // Dropdown
  dropdownContainer: { position: 'relative', zIndex: 100 },
  dropdownBtn: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    borderWidth: 1.5, borderColor: COLORS.border, borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.md,
    backgroundColor: COLORS.white,
  },
  dropdownPlaceholder: { ...FONTS.bodySm, color: COLORS.textTertiary },
  dropdownList: {
    borderWidth: 1.5, borderColor: COLORS.border, borderRadius: RADIUS.md,
    marginTop: SPACING.xs, backgroundColor: COLORS.white, ...SHADOWS.md,
    maxHeight: 200,
  },
  dropdownItem: {
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.md,
    borderBottomWidth: 1, borderBottomColor: COLORS.borderLight,
  },
  dropdownItemText: { ...FONTS.bodySm, color: COLORS.text },

  // Save Button
  saveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    backgroundColor: COLORS.primary, paddingVertical: SPACING.md, borderRadius: RADIUS.md,
    marginBottom: SPACING.lg,
  },
  saveBtnDisabled: {
    backgroundColor: COLORS.textTertiary,
  },
  saveBtnText: { ...FONTS.button, color: COLORS.white },

  // Family Member
  familyCard: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
    paddingVertical: SPACING.md, borderBottomWidth: 1, borderBottomColor: COLORS.borderLight,
  },
  familyInfo: { flex: 1 },
  familyName: { ...FONTS.bodyMedium, fontWeight: '600' },
  familyRole: { ...FONTS.caption, color: COLORS.textSecondary, marginTop: 2 },
  familyDietaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs, marginTop: SPACING.sm },
  familyDietaryChip: {
    backgroundColor: COLORS.borderLight, paddingHorizontal: SPACING.sm,
    paddingVertical: 4, borderRadius: RADIUS.sm,
  },
  familyDietaryText: { ...FONTS.caption, color: COLORS.text },
  deleteBtn: { padding: SPACING.xs },

  // Add Row Button
  addRowBtn: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    paddingVertical: SPACING.md, marginTop: SPACING.sm,
  },
  addRowText: { ...FONTS.bodySm, color: COLORS.textSecondary },

  // Store Card
  storeCard: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
    paddingVertical: SPACING.md, borderBottomWidth: 1, borderBottomColor: COLORS.borderLight,
  },
  storeInfo: { flex: 1 },
  storeName: { ...FONTS.bodyMedium, fontWeight: '600' },
  storeNote: { ...FONTS.caption, color: COLORS.textSecondary, marginTop: 2 },

  // History
  historyItem: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingVertical: SPACING.md, borderBottomWidth: 1, borderBottomColor: COLORS.borderLight,
  },
  historyLeft: { flex: 1 },
  historyIconRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  historyStore: { ...FONTS.bodyMedium, fontWeight: '600' },
  historyDate: { ...FONTS.caption, color: COLORS.textSecondary, marginTop: 2 },
  historyNote: { ...FONTS.caption, color: COLORS.textSecondary, marginTop: SPACING.xs, fontStyle: 'italic' },
  historyRight: { alignItems: 'flex-end' },
  historyAmount: { ...FONTS.bodyMedium, fontWeight: '700' },
  historyItems: { ...FONTS.caption, color: COLORS.textSecondary, marginTop: 2 },

  // Logout
  logoutBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    backgroundColor: '#FEE2E2', paddingVertical: SPACING.md, borderRadius: RADIUS.md,
    marginTop: SPACING.lg,
  },
  logoutText: { ...FONTS.button, color: COLORS.red },

  // Primary Button (modal)
  primaryBtn: {
    backgroundColor: COLORS.primary, borderRadius: RADIUS.md,
    paddingVertical: SPACING.md, alignItems: 'center', marginTop: SPACING.xl,
  },
  primaryBtnText: { ...FONTS.button, color: COLORS.white },

  // Modal
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center', alignItems: 'center', padding: SPACING.lg,
  },
  modalContent: {
    backgroundColor: COLORS.white, borderRadius: RADIUS.lg,
    padding: SPACING.xl, width: '100%', maxWidth: 400,
    ...SHADOWS.lg,
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: SPACING.lg,
  },
  modalTitle: { ...FONTS.h4, fontWeight: '700' },
  inputLabel: { ...FONTS.label, marginBottom: SPACING.sm, marginTop: SPACING.md },
  textInput: {
    borderWidth: 1.5, borderColor: COLORS.border, borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.md,
    ...FONTS.body, color: COLORS.text,
  },
});